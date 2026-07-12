// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title HoodToken
/// @notice A minimal, complete, fixed-supply ERC-20 used by `hood deploy-token`.
///         The entire supply is minted to the deployer at construction; there is
///         no mint/owner/pause surface — what you deploy is immutable. Standard
///         ERC-20 semantics (EIP-20): 18-decimal default, checked arithmetic
///         (Solidity 0.8 reverts on overflow/underflow).
/// @dev    Self-contained (no imports) so it compiles with a bare solc and the
///         committed artifact in contracts/ERC20.json is byte-for-byte
///         reproducible: `npm run compile-erc20`.
contract HoodToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// @param _name        Token name.
    /// @param _symbol      Token ticker.
    /// @param _decimals    Token decimals (18 is the ERC-20 convention).
    /// @param _initialSupply Whole-token supply; scaled by 10**_decimals and
    ///                        minted in full to the deployer.
    constructor(string memory _name, string memory _symbol, uint8 _decimals, uint256 _initialSupply) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
        uint256 supply = _initialSupply * (10 ** uint256(_decimals));
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return _transfer(msg.sender, to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "ERC20: insufficient allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        return _transfer(from, to, value);
    }

    function _transfer(address from, address to, uint256 value) internal returns (bool) {
        require(to != address(0), "ERC20: transfer to the zero address");
        uint256 fromBalance = balanceOf[from];
        require(fromBalance >= value, "ERC20: transfer amount exceeds balance");
        unchecked {
            balanceOf[from] = fromBalance - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
        return true;
    }
}
