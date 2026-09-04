//! Knock escrow: a priced message to a person that pays out only against a reply.
//!
//! The live knock product settles the sender's payment straight to the owner's
//! wallet the moment it clears, and its own schema says so: "Nothing here holds
//! funds." That is fine between people who already trust each other and wrong
//! for an open market. The sender pays first and unconditionally, so an owner
//! can bank every knock and answer none, and the sender has no recourse. At any
//! real volume that is the whole market: senders stop paying strangers, and the
//! price signal that made knock work stops meaning anything.
//!
//! This program makes the money conditional. A knock parks the payment in a
//! vault owned by the knock's own PDA. Three things can happen to it, and only
//! three:
//!
//!   - the owner **answers** inside the reply window and is paid, minus the
//!     protocol fee;
//!   - the owner **refuses**, and the sender is refunded in full, with no fee
//!     taken, because refusing to read something is not a service;
//!   - nobody does anything and the window closes, so **anyone** can crank the
//!     refund and the sender gets everything back.
//!
//! There is no fourth path and no admin key that can move a parked knock. The
//! authority in `Config` sets the fee and the treasury for knocks made after it
//! acts; it cannot touch a vault, cannot answer on an owner's behalf, and cannot
//! stop a refund. A sender's worst case is that their money is unavailable until
//! the window they agreed to expires.
//!
//! Message bodies never touch the chain. A knock records the SHA-256 of the
//! message and an answer records the SHA-256 of the reply, so either side can
//! later prove what was actually sent without publishing a stranger's private
//! message to a public ledger.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("uVX46U6sGUs6PD3339ZXbTpMyhZwkQhBLPxnvRX9ps7");

/// PDA seed for the singleton protocol config.
const CONFIG_SEED: &[u8] = b"config";
/// PDA seed prefix for a per-(owner, door id) door.
const DOOR_SEED: &[u8] = b"door";
/// PDA seed prefix for a single escrowed knock.
const KNOCK_SEED: &[u8] = b"knock";
/// PDA seed prefix for a knock's vault token account.
const VAULT_SEED: &[u8] = b"vault";

/// Hard ceiling on the protocol fee, in basis points (10%).
///
/// A fee is a parameter, but an unbounded fee is a rug: an authority that can
/// set 100% can take every future answer. The ceiling is enforced in code so the
/// worst an authority can do is bounded by something a reader can check here.
const MAX_FEE_BPS: u16 = 1_000;

/// Shortest reply window an owner may set (one hour).
///
/// A window measured in seconds would let an owner take a payment and let it
/// lapse before a human could plausibly read it.
const MIN_REPLY_WINDOW: i64 = 60 * 60;
/// Longest reply window an owner may set (30 days). Bounds how long a sender's
/// money can be parked.
const MAX_REPLY_WINDOW: i64 = 60 * 60 * 24 * 30;

/// Largest price a door may set, in the mint's atomic units.
///
/// Mirrors the `knock_doors_price_chk` bound in the live schema (1000 USDC at 6
/// decimals), so a door cannot be priced on-chain in a way the product refuses
/// to render off-chain.
const MAX_PRICE: u64 = 1_000_000_000;

#[program]
pub mod knock_escrow {
    use super::*;

    /// Create the singleton config. The signer becomes the authority.
    pub fn initialize(ctx: Context<Initialize>, treasury: Pubkey, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, KnockError::FeeTooHigh);
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.treasury = treasury;
        config.fee_bps = fee_bps;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Change the fee, the treasury, or the authority.
    ///
    /// This only affects knocks created after it lands: a knock snapshots the
    /// fee at the moment it is made, so nobody's escrowed payment can be
    /// repriced out from under them.
    pub fn set_config(
        ctx: Context<SetConfig>,
        treasury: Option<Pubkey>,
        fee_bps: Option<u16>,
        authority: Option<Pubkey>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        if let Some(bps) = fee_bps {
            require!(bps <= MAX_FEE_BPS, KnockError::FeeTooHigh);
            config.fee_bps = bps;
        }
        if let Some(t) = treasury {
            config.treasury = t;
        }
        if let Some(a) = authority {
            require!(a != Pubkey::default(), KnockError::InvalidAuthority);
            config.authority = a;
        }
        Ok(())
    }

    /// Open a priced door. `door_id` is a 32-byte client-chosen id (the live
    /// product uses the SHA-256 of the owner's username) so one account can run
    /// more than one door without a second signer.
    pub fn open_door(
        ctx: Context<OpenDoor>,
        door_id: [u8; 32],
        price: u64,
        reply_window: i64,
    ) -> Result<()> {
        require!(price > 0, KnockError::PriceZero);
        require!(price <= MAX_PRICE, KnockError::PriceTooHigh);
        require!(
            (MIN_REPLY_WINDOW..=MAX_REPLY_WINDOW).contains(&reply_window),
            KnockError::ReplyWindowOutOfRange
        );

        let door = &mut ctx.accounts.door;
        door.owner = ctx.accounts.owner.key();
        door.mint = ctx.accounts.mint.key();
        door.door_id = door_id;
        door.price = price;
        door.reply_window = reply_window;
        door.open = true;
        door.knocks = 0;
        door.answered = 0;
        door.refunded = 0;
        door.earned = 0;
        door.bump = ctx.bumps.door;
        Ok(())
    }

    /// Reprice a door, change its reply window, or shut it.
    ///
    /// Shutting a door stops new knocks. It deliberately does NOT touch knocks
    /// already in flight: those are owed an answer or a refund, and closing up
    /// shop is not a way to escape either.
    pub fn set_door(
        ctx: Context<SetDoor>,
        price: Option<u64>,
        reply_window: Option<i64>,
        open: Option<bool>,
    ) -> Result<()> {
        let door = &mut ctx.accounts.door;
        if let Some(p) = price {
            require!(p > 0, KnockError::PriceZero);
            require!(p <= MAX_PRICE, KnockError::PriceTooHigh);
            door.price = p;
        }
        if let Some(w) = reply_window {
            require!(
                (MIN_REPLY_WINDOW..=MAX_REPLY_WINDOW).contains(&w),
                KnockError::ReplyWindowOutOfRange
            );
            door.reply_window = w;
        }
        if let Some(o) = open {
            door.open = o;
        }
        Ok(())
    }

    /// Pay the door's price into escrow and record one knock.
    ///
    /// `nonce` lets one sender knock the same door repeatedly; `message_hash`
    /// is the SHA-256 of the message body, which stays off-chain.
    pub fn knock(ctx: Context<Knock>, nonce: u64, message_hash: [u8; 32]) -> Result<()> {
        let door = &ctx.accounts.door;
        require!(door.open, KnockError::DoorClosed);
        require_keys_eq!(door.mint, ctx.accounts.mint.key(), KnockError::WrongMint);

        let price = door.price;
        let now = Clock::get()?.unix_timestamp;
        let expires_at = now
            .checked_add(door.reply_window)
            .ok_or(KnockError::MathOverflow)?;

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.sender_tokens.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.sender.to_account_info(),
                },
            ),
            price,
            ctx.accounts.mint.decimals,
        )?;

        let knock_key = ctx.accounts.knock.key();
        let door_key = ctx.accounts.door.key();
        let sender_key = ctx.accounts.sender.key();

        let knock = &mut ctx.accounts.knock;
        knock.door = door_key;
        knock.sender = sender_key;
        knock.mint = ctx.accounts.mint.key();
        knock.amount = price;
        // Snapshot the fee: an authority that raises it later cannot reach back
        // into a knock somebody already paid for.
        knock.fee_bps = ctx.accounts.config.fee_bps;
        knock.nonce = nonce;
        knock.message_hash = message_hash;
        knock.reply_hash = [0u8; 32];
        knock.created_at = now;
        knock.expires_at = expires_at;
        knock.state = KnockState::Pending as u8;
        knock.bump = ctx.bumps.knock;
        knock.vault_bump = ctx.bumps.vault;

        let door = &mut ctx.accounts.door;
        door.knocks = door.knocks.checked_add(1).ok_or(KnockError::MathOverflow)?;

        emit!(Knocked {
            door: door_key,
            knock: knock_key,
            sender: sender_key,
            amount: price,
            expires_at,
            message_hash,
        });
        Ok(())
    }

    /// Answer a knock and take the payment, minus the fee snapshotted at knock time.
    ///
    /// Only the door's owner can call this, and only before the window closes.
    /// A late answer is not an error the program can paper over: the sender was
    /// promised their money back at that instant, so the only path left is the
    /// refund.
    pub fn answer(ctx: Context<Answer>, reply_hash: [u8; 32]) -> Result<()> {
        let knock = &ctx.accounts.knock;
        require!(
            knock.state == KnockState::Pending as u8,
            KnockError::KnockNotPending
        );
        let now = Clock::get()?.unix_timestamp;
        require!(now <= knock.expires_at, KnockError::ReplyWindowClosed);

        let amount = knock.amount;
        // Integer division truncates toward zero, so the remainder always lands
        // with the owner rather than the treasury. A fee is never rounded up.
        let fee = (amount as u128)
            .checked_mul(knock.fee_bps as u128)
            .ok_or(KnockError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(KnockError::MathOverflow)? as u64;
        let payout = amount.checked_sub(fee).ok_or(KnockError::MathOverflow)?;

        let knock_key = ctx.accounts.knock.key();
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, knock_key.as_ref(), &[knock.vault_bump]];
        let signer: &[&[&[u8]]] = &[vault_seeds];
        let decimals = ctx.accounts.mint.decimals;

        if payout > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.owner_tokens.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    signer,
                ),
                payout,
                decimals,
            )?;
        }
        if fee > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.treasury_tokens.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    signer,
                ),
                fee,
                decimals,
            )?;
        }

        close_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.sender,
            signer,
        )?;

        let knock = &mut ctx.accounts.knock;
        knock.state = KnockState::Answered as u8;
        knock.reply_hash = reply_hash;

        let door = &mut ctx.accounts.door;
        door.answered = door
            .answered
            .checked_add(1)
            .ok_or(KnockError::MathOverflow)?;
        door.earned = door
            .earned
            .checked_add(payout)
            .ok_or(KnockError::MathOverflow)?;

        emit!(Answered {
            door: knock.door,
            knock: knock_key,
            sender: knock.sender,
            payout,
            fee,
            reply_hash,
        });
        Ok(())
    }

    /// Decline a knock and refund the sender in full, with no fee.
    ///
    /// This is the honest path for a door owner who will not engage, and it is
    /// deliberately cheaper for them than letting the window lapse: it returns
    /// the sender's rent immediately and leaves a record that they refused
    /// rather than ignored.
    pub fn refuse(ctx: Context<Refuse>) -> Result<()> {
        let knock = &ctx.accounts.knock;
        require!(
            knock.state == KnockState::Pending as u8,
            KnockError::KnockNotPending
        );
        let knock_key = ctx.accounts.knock.key();
        let door_key = knock.door;
        let sender_key = knock.sender;
        let amount = knock.amount;
        settle_refund(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.mint,
            &ctx.accounts.sender_tokens,
            &ctx.accounts.sender,
            ctx.accounts.knock.key(),
            knock.amount,
            knock.vault_bump,
        )?;

        let knock = &mut ctx.accounts.knock;
        knock.state = KnockState::Refused as u8;
        let door = &mut ctx.accounts.door;
        door.refunded = door
            .refunded
            .checked_add(1)
            .ok_or(KnockError::MathOverflow)?;

        emit!(Refunded {
            door: door_key,
            knock: knock_key,
            sender: sender_key,
            amount,
            refused: true,
        });
        Ok(())
    }

    /// Refund an unanswered knock once its window has closed.
    ///
    /// Permissionless on purpose. If only the sender could crank this, a sender
    /// who lost their key or simply stopped watching would leave the money
    /// stranded forever, and the guarantee would be worth only as much as the
    /// sender's diligence. Anyone can call it; the funds can only ever go to
    /// the sender's own token account.
    pub fn reclaim(ctx: Context<Reclaim>) -> Result<()> {
        let knock = &ctx.accounts.knock;
        require!(
            knock.state == KnockState::Pending as u8,
            KnockError::KnockNotPending
        );
        let now = Clock::get()?.unix_timestamp;
        require!(now > knock.expires_at, KnockError::ReplyWindowOpen);

        let knock_key = ctx.accounts.knock.key();
        let door_key = knock.door;
        let sender_key = knock.sender;
        let amount = knock.amount;
        settle_refund(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.mint,
            &ctx.accounts.sender_tokens,
            &ctx.accounts.sender,
            ctx.accounts.knock.key(),
            knock.amount,
            knock.vault_bump,
        )?;

        let knock = &mut ctx.accounts.knock;
        knock.state = KnockState::Refunded as u8;
        let door = &mut ctx.accounts.door;
        door.refunded = door
            .refunded
            .checked_add(1)
            .ok_or(KnockError::MathOverflow)?;

        emit!(Refunded {
            door: door_key,
            knock: knock_key,
            sender: sender_key,
            amount,
            refused: false,
        });
        Ok(())
    }
}

/// Move the whole vault balance back to the sender and close the vault.
///
/// Shared by `refuse` and `reclaim` so the two refund paths cannot drift into
/// disagreeing about how much comes back. Both return everything.
#[allow(clippy::too_many_arguments)]
fn settle_refund<'info>(
    token_program: &Interface<'info, TokenInterface>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    sender_tokens: &InterfaceAccount<'info, TokenAccount>,
    sender: &SystemAccount<'info>,
    knock_key: Pubkey,
    amount: u64,
    vault_bump: u8,
) -> Result<()> {
    let vault_seeds: &[&[u8]] = &[VAULT_SEED, knock_key.as_ref(), &[vault_bump]];
    let signer: &[&[&[u8]]] = &[vault_seeds];

    if amount > 0 {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                TransferChecked {
                    from: vault.to_account_info(),
                    mint: mint.to_account_info(),
                    to: sender_tokens.to_account_info(),
                    authority: vault.to_account_info(),
                },
                signer,
            ),
            amount,
            mint.decimals,
        )?;
    }
    close_vault(token_program, vault, sender, signer)
}

/// Close an emptied vault and return its rent to the sender, who paid it.
fn close_vault<'info>(
    token_program: &Interface<'info, TokenInterface>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    sender: &SystemAccount<'info>,
    signer: &[&[&[u8]]],
) -> Result<()> {
    token_interface::close_account(CpiContext::new_with_signer(
        token_program.to_account_info(),
        CloseAccount {
            account: vault.to_account_info(),
            destination: sender.to_account_info(),
            authority: vault.to_account_info(),
        },
        signer,
    ))
}

// ── accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetConfig<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ KnockError::Unauthorized
    )]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(door_id: [u8; 32])]
pub struct OpenDoor<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = owner,
        space = 8 + Door::INIT_SPACE,
        seeds = [DOOR_SEED, owner.key().as_ref(), door_id.as_ref()],
        bump
    )]
    pub door: Account<'info, Door>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetDoor<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [DOOR_SEED, owner.key().as_ref(), door.door_id.as_ref()],
        bump = door.bump,
        has_one = owner @ KnockError::Unauthorized
    )]
    pub door: Account<'info, Door>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct Knock<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [DOOR_SEED, door.owner.as_ref(), door.door_id.as_ref()],
        bump = door.bump
    )]
    pub door: Account<'info, Door>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        constraint = sender_tokens.mint == mint.key() @ KnockError::WrongMint,
        constraint = sender_tokens.owner == sender.key() @ KnockError::Unauthorized
    )]
    pub sender_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = sender,
        space = 8 + KnockRecord::INIT_SPACE,
        seeds = [KNOCK_SEED, door.key().as_ref(), sender.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub knock: Account<'info, KnockRecord>,
    // The vault is its own authority: the PDA that owns the tokens is the same
    // PDA the program signs for, so no wallet anywhere can move an escrowed
    // knock, including the protocol authority.
    #[account(
        init,
        payer = sender,
        seeds = [VAULT_SEED, knock.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = vault,
        token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Answer<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [DOOR_SEED, door.owner.as_ref(), door.door_id.as_ref()],
        bump = door.bump,
        has_one = owner @ KnockError::Unauthorized
    )]
    pub door: Account<'info, Door>,
    #[account(
        mut,
        seeds = [KNOCK_SEED, door.key().as_ref(), knock.sender.as_ref(), &knock.nonce.to_le_bytes()],
        bump = knock.bump,
        has_one = door @ KnockError::WrongDoor,
        has_one = mint @ KnockError::WrongMint
    )]
    pub knock: Account<'info, KnockRecord>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        seeds = [VAULT_SEED, knock.key().as_ref()],
        bump = knock.vault_bump
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        constraint = owner_tokens.mint == mint.key() @ KnockError::WrongMint,
        constraint = owner_tokens.owner == owner.key() @ KnockError::Unauthorized
    )]
    pub owner_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        constraint = treasury_tokens.mint == mint.key() @ KnockError::WrongMint,
        constraint = treasury_tokens.owner == config.treasury @ KnockError::WrongTreasury
    )]
    pub treasury_tokens: InterfaceAccount<'info, TokenAccount>,
    /// Rent destination for the closed vault. Checked against the knock, so the
    /// sender's deposit can only ever come back to the sender.
    #[account(mut, address = knock.sender @ KnockError::WrongSender)]
    pub sender: SystemAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Refuse<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [DOOR_SEED, door.owner.as_ref(), door.door_id.as_ref()],
        bump = door.bump,
        has_one = owner @ KnockError::Unauthorized
    )]
    pub door: Account<'info, Door>,
    #[account(
        mut,
        seeds = [KNOCK_SEED, door.key().as_ref(), knock.sender.as_ref(), &knock.nonce.to_le_bytes()],
        bump = knock.bump,
        has_one = door @ KnockError::WrongDoor,
        has_one = mint @ KnockError::WrongMint
    )]
    pub knock: Account<'info, KnockRecord>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        seeds = [VAULT_SEED, knock.key().as_ref()],
        bump = knock.vault_bump
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        constraint = sender_tokens.mint == mint.key() @ KnockError::WrongMint,
        constraint = sender_tokens.owner == knock.sender @ KnockError::WrongSender
    )]
    pub sender_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = knock.sender @ KnockError::WrongSender)]
    pub sender: SystemAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Reclaim<'info> {
    /// Whoever cranks the refund. Pays the transaction and gets nothing for it;
    /// every lamport and token in this instruction goes to the sender.
    pub cranker: Signer<'info>,
    #[account(
        mut,
        seeds = [DOOR_SEED, door.owner.as_ref(), door.door_id.as_ref()],
        bump = door.bump
    )]
    pub door: Account<'info, Door>,
    #[account(
        mut,
        seeds = [KNOCK_SEED, door.key().as_ref(), knock.sender.as_ref(), &knock.nonce.to_le_bytes()],
        bump = knock.bump,
        has_one = door @ KnockError::WrongDoor,
        has_one = mint @ KnockError::WrongMint
    )]
    pub knock: Account<'info, KnockRecord>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        seeds = [VAULT_SEED, knock.key().as_ref()],
        bump = knock.vault_bump
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        constraint = sender_tokens.mint == mint.key() @ KnockError::WrongMint,
        constraint = sender_tokens.owner == knock.sender @ KnockError::WrongSender
    )]
    pub sender_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = knock.sender @ KnockError::WrongSender)]
    pub sender: SystemAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

// ── state ───────────────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub fee_bps: u16,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Door {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub door_id: [u8; 32],
    pub price: u64,
    pub reply_window: i64,
    pub open: bool,
    pub knocks: u64,
    pub answered: u64,
    pub refunded: u64,
    pub earned: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct KnockRecord {
    pub door: Pubkey,
    pub sender: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub fee_bps: u16,
    pub nonce: u64,
    pub message_hash: [u8; 32],
    pub reply_hash: [u8; 32],
    pub created_at: i64,
    pub expires_at: i64,
    pub state: u8,
    pub bump: u8,
    pub vault_bump: u8,
}

/// Terminal states are terminal: a knock leaves `Pending` exactly once.
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum KnockState {
    Pending = 0,
    Answered = 1,
    Refunded = 2,
    Refused = 3,
}

// ── events ──────────────────────────────────────────────────────────────────

#[event]
pub struct Knocked {
    pub door: Pubkey,
    pub knock: Pubkey,
    pub sender: Pubkey,
    pub amount: u64,
    pub expires_at: i64,
    pub message_hash: [u8; 32],
}

#[event]
pub struct Answered {
    pub door: Pubkey,
    pub knock: Pubkey,
    pub sender: Pubkey,
    pub payout: u64,
    pub fee: u64,
    pub reply_hash: [u8; 32],
}

#[event]
pub struct Refunded {
    pub door: Pubkey,
    pub knock: Pubkey,
    pub sender: Pubkey,
    pub amount: u64,
    /// True when the owner declined outright, false when the window lapsed.
    pub refused: bool,
}

// ── errors ──────────────────────────────────────────────────────────────────

#[error_code]
pub enum KnockError {
    #[msg("Protocol fee exceeds the 10% ceiling")]
    FeeTooHigh,
    #[msg("Authority cannot be the default pubkey")]
    InvalidAuthority,
    #[msg("A door price must be greater than zero")]
    PriceZero,
    #[msg("A door price exceeds the maximum")]
    PriceTooHigh,
    #[msg("Reply window must be between 1 hour and 30 days")]
    ReplyWindowOutOfRange,
    #[msg("This door is not accepting knocks")]
    DoorClosed,
    #[msg("Token mint does not match")]
    WrongMint,
    #[msg("Knock does not belong to this door")]
    WrongDoor,
    #[msg("Account does not belong to the knock's sender")]
    WrongSender,
    #[msg("Treasury token account does not belong to the configured treasury")]
    WrongTreasury,
    #[msg("Signer is not authorized")]
    Unauthorized,
    #[msg("This knock has already been answered or refunded")]
    KnockNotPending,
    #[msg("The reply window has closed; the sender is owed a refund")]
    ReplyWindowClosed,
    #[msg("The reply window is still open")]
    ReplyWindowOpen,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}

/// Unused import guard: `AssociatedToken` is referenced so a client deriving
/// ATAs against this program's IDL sees the program in the account list.
#[allow(dead_code)]
type AtaProgram<'info> = Program<'info, AssociatedToken>;
