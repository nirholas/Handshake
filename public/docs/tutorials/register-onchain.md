# Tutorial: Register Your Agent On-Chain

Give your three.ws a permanent blockchain identity anyone can verify.

---

## Why bother?

Right now your agent lives on a platform. If the platform goes away, so does the proof that you created it. Registering on-chain changes that:

- **Anyone can verify you created it.** The registry is a public smart contract on Base — no account, no login, no trust in any company required.
- **Your agent gets a permanent URL** that resolves directly from on-chain data: `https://three.ws/a/8453/<id>`. Share it anywhere.
- **Users can leave verifiable reviews.** Every reputation score is a transaction, not a database row.
- **You can transfer it.** Sell it, gift it, or move it to a hardware wallet — same as any NFT.
- **Full auditability.** Every registration, update, and review is public and timestamped.

ERC-8004 is the open standard behind this. You don't need to understand the spec to use it — this tutorial walks through every click.

---

## What you'll need

**An Ethereum wallet with a small amount of ETH on Base (chain ID 8453).**

Base is a Layer 2 network built on Ethereum. Transactions cost a fraction of a cent. You need roughly $0.50–$1 worth of ETH to cover registration gas.

**Don't have ETH on Base yet?** Three options:

- **Bridge from Ethereum mainnet** — go to [bridge.base.org](https://bridge.base.org), connect your wallet, and move 0.001–0.002 ETH across. Total cost including bridge fee: ~$2–4.
- **Buy directly on Base** — Coinbase supports Base withdrawals natively. Any exchange that supports Base works.
- **Use the testnet for free practice** — Base Sepolia (chain ID 84532) is a test network where ETH has no real value. Get free testnet ETH from the [Coinbase Base Sepolia faucet](https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet). This is the best option if you want to try the flow before spending real money.

**A three.ws.** Step 1 covers creating one if you don't have one yet.

---

## Step 1: Create your agent

Skip this step if you already have an agent saved to your account.

**Option A — Generate from a photo:**

1. Go to [three.ws/create](https://three.ws/create)
2. Take a selfie or upload a photo
3. Your avatar generates in about 30 seconds
4. Give it a name and description
5. Click **Save**

**Option B — Upload an existing GLB:**

1. Go to [three.ws/app](https://three.ws/app)
2. Drag your `.glb` file into the viewer
3. Open the **Manifest** tab in the editor panel
4. Fill in the name and description fields
5. Click **Save to Account**

Either way, you should end up with an agent visible in your dashboard at [three.ws/dashboard](https://three.ws/dashboard).

---

## Step 2: Get ETH on Base

If you already have ETH on Base, skip ahead to Step 3.

**I already have ETH on Ethereum mainnet:**

1. Go to [bridge.base.org](https://bridge.base.org)
2. Connect your wallet
3. Enter the amount to bridge (0.001–0.002 ETH is enough)
4. Approve the bridge transaction in your wallet
5. Wait ~2 minutes for the funds to arrive on Base

**I want to practice first (free testnet):**

1. Go to the [Coinbase Base Sepolia faucet](https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet)
2. Enter your wallet address
3. Receive free testnet ETH (no real value)
4. In the app, select **Base Sepolia** from the chain dropdown instead of Base

**What is gas?** Every action on a blockchain requires a small fee paid to the validators who process it. On Base, this fee (called "gas") is tiny — registering an agent costs roughly $0.05–0.20 depending on network load. Gas is paid in ETH, which is why you need some on Base before starting.

---

## Step 3: Connect your wallet

1. In the three.ws app, click **Connect Wallet** in the top-right corner
2. Choose how you want to connect:
   - **MetaMask** — click the MetaMask icon and approve in the extension
   - **Coinbase Wallet** — click the Coinbase icon
   - **WalletConnect** — scan the QR code with any mobile wallet
   - **Email login** — enter your email address; a self-custodied embedded wallet is created automatically via Privy (no browser extension needed)
   - **Google login** — same as email, just faster

3. If you're prompted to sign a message ("Sign in to three.ws..."), sign it — this proves wallet ownership and costs no gas.

4. Your shortened address appears in the header: `0xABcd…EF12 · Base`

**Wrong network?** If the button shows "Switch to Base", click it. Your wallet will prompt you to switch — approve it. If Base isn't in your wallet yet, the app adds it automatically.

---

## Step 4: Open your agent for editing

1. Go to [three.ws/dashboard](https://three.ws/dashboard)
2. Find the agent you want to register
3. Click **Edit** — the editor opens with your avatar loaded

Make sure the agent has a name and description filled in before continuing. These are what gets stored on-chain.

---

## Step 5: Start the registration

On your agent's profile page or in the editor, find the **⬢ Deploy on-chain** button.

- If you're on the agent's page, it appears near the top
- If you're in the editor, it's in the top-right toolbar

**Select your chain** from the dropdown (Base is pre-selected). If you're practicing on testnet, switch to **Base Sepolia**.

Click **⬢ Deploy on-chain**.

---

## Step 6: Watch the registration pipeline

The button shows a live progress indicator with four stages:

```
Preparing manifest → Sign tx → Confirming on-chain → Saving
```

**Preparing manifest** — The server pins your agent's metadata (name, description, 3D model URL) to IPFS and returns a content-addressed identifier called a CID. This CID is what gets written on-chain — it's a permanent, tamper-proof reference to exactly these metadata bytes. This takes 2–10 seconds.

The metadata is structured as an [ERC-8004 registration JSON](https://eips.ethereum.org/EIPS/eip-8004), which looks like:

```json
{
  "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  "name": "Your Agent Name",
  "description": "What your agent does",
  "image": "ipfs://...",
  "active": true,
  "services": [
    { "name": "avatar", "endpoint": "ipfs://...body.glb", "version": "gltf-2.0" }
  ],
  "registrations": [...],
  "supportedTrust": ["reputation"]
}
```

---

## Step 7: Confirm the transaction in your wallet

After the manifest is prepared, the progress bar moves to **Sign tx** and your wallet opens automatically.

You'll see a transaction prompt showing:
- The contract address (the ERC-8004 Identity Registry on Base)
- The estimated gas fee (typically 0.00005–0.0002 ETH, roughly $0.05–0.20)
- No ETH value transfer — only the gas fee leaves your wallet

Review the details and click **Confirm** (or **Approve**, depending on your wallet).

Base is fast. The transaction confirms in 2–5 seconds. The progress bar moves through **Confirming on-chain** and then **Saving**.

---

## Step 8: Your agent is on-chain

When the progress completes, the button flips to a success chip:

```
⬢ On-chain on Base · view on explorer
```

Clicking it opens Basescan showing the Identity Registry contract. You can see your registration transaction in the list.

Your agent now has:

- An **on-chain ID** — a number unique to this registry (e.g., `42`)
- A **permanent URL**: `https://three.ws/a/8453/42`
- A **Passport widget** visible at that URL showing your ERC-8004 identity

Open your agent's URL in a new tab. You should see your 3D avatar with the Passport widget showing the on-chain registration details, chain, and block explorer link.

---

## Step 9: Share your agent

Your on-chain URL works anywhere. Try these:

**Post on social:**
Share `https://three.ws/a/8453/42` on Twitter/X, Farcaster, or Lens. Anyone who clicks it sees your verified agent — no account required.

**Add to your website:**
Drop the Passport widget in anywhere HTML is accepted:

```html
<script type="module" src="https://three.ws/lib.js"></script>
<agent-3d widget="passport" agent-id="8453:0xRegistryAddress:42"></agent-3d>
```

Replace `0xRegistryAddress` with the Identity Registry contract address shown on Basescan, and `42` with your agent ID.

**Generate a QR code:**
On your agent's page, click the QR icon in the Passport widget. A scannable code appears — save it or screenshot it for physical printouts, conference badges, or business cards.

**Include it in a README or profile:**
A Markdown link works: `[My three.ws](https://three.ws/a/8453/42)`

---

## Step 10: Build your reputation

Your agent's page at `https://three.ws/a/8453/42` has a **Reputation** section. Every review is a transaction on Base — public, permanent, and attached to the reviewer's wallet address.

**Ask others to leave a review:**

1. Send them your agent URL
2. They scroll to the Reputation section
3. They connect their wallet and click **Leave a review**
4. They pick a score (0–255, where 255 is the max) and optionally add a comment
5. They confirm the transaction (~$0.05 gas)

**Read your reputation programmatically:**

```js
import { getReputation } from './src/erc8004/reputation.js';
import { JsonRpcProvider } from 'ethers';

const provider = new JsonRpcProvider('https://mainnet.base.org');
const { total, count, average } = await getReputation({
  agentId: 42,
  runner: provider,
  chainId: 8453,
});

console.log(`${count} reviews, average score: ${average.toFixed(1)}`);
```

There's no way to delete or edit a review after it's submitted — that's the point.

---

## Step 11 (optional): Link to your ENS name

If you own an ENS name like `yourname.eth`, you can make it resolve to your agent. This creates a bidirectional verified link between your human-readable name and your on-chain agent.

**Forward record (name → agent):**

1. Go to [app.ens.domains](https://app.ens.domains)
2. Click your ENS name → **Records**
3. Click **Edit records** → **Add record**
4. Key: `agent`
5. Value: `eip155:8453:0xRegistryAddress/42`

   Replace `0xRegistryAddress` with the Identity Registry address and `42` with your agent ID. The full CAIP-10 format is required.

6. Save (requires one gas transaction)

**Reverse record (agent → name):**

In your agent's manifest or on the registration page, add a `claims` entry pointing back at your ENS name. The system only shows a "verified" badge when both directions match — the ENS record points to your agent *and* your agent's card lists the ENS name. This prevents someone from putting your domain in their card to steal credibility.

Once set, your agent is accessible at:
`https://three.ws/agent/ens/yourname.eth`

---

## Troubleshooting

**Wallet won't connect**
- Try refreshing the page and clicking Connect Wallet again
- If MetaMask doesn't open, check that the extension is enabled and unlocked
- Try a different browser — some wallets work better in Chrome vs Firefox
- Email login is the most reliable fallback: no extension needed

**"Preparing manifest" takes more than 30 seconds**
- Wait up to 60 seconds — IPFS pin providers can be slow under load
- If it fails, click **Try again** — the app caches your prep record so it won't re-upload if the previous attempt partly succeeded
- A second attempt almost always succeeds

**"Insufficient funds" error**
- You need a small amount of ETH on Base (not just Ethereum mainnet)
- Bridge ETH to Base at [bridge.base.org](https://bridge.base.org), or use the testnet to practice first

**"A pending transaction from this wallet is blocking the new one"**
- You have a stuck or pending transaction in your wallet
- Open MetaMask → Activity tab → find the pending tx → Speed Up or Cancel it
- Try again after it clears

**Transaction reverted**
- Rare on Base. Usually means the contract received unexpected input.
- Try refreshing the page and starting the registration again — the cached prep record will be reused so you don't pay for IPFS pinning twice

**"Wallet is on a different network"**
- Click the **Switch to Base** button that appears in the error
- Your wallet prompts you to switch — approve it
- If Base isn't in your wallet, the app adds it automatically using the official RPC and chain data

**Wrong chain ID in MetaMask**
- Open MetaMask → network selector → choose Base (chain ID 8453)
- If it's not listed: Settings → Networks → Add network → search "Base" or add manually with RPC `https://mainnet.base.org`

**Mint succeeded but "Saving" step failed**
- Your agent is on-chain — the token was minted. Only the database sync failed.
- The error message shows your transaction hash (`0x…`). Copy it.
- Refresh the page. The app should detect the existing on-chain registration and link it automatically.
- If not, contact support with your wallet address and transaction hash.

---

## What's next

Now that your agent has an on-chain identity, you can:

- **Embed the Passport widget** on your website or portfolio
- **Add services** to your registration — an A2A endpoint, an MCP server, or a website — so other agents and apps can discover your agent's capabilities automatically
- **Validate your 3D model** and attach a signed validation report to your on-chain card
- **Transfer the token** to a hardware wallet for safer long-term custody

Your agent's URL will keep working as long as Base exists and IPFS gateways serve the pinned content — which is designed to be indefinite.
