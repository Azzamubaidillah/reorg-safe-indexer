// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// Emits the ERC-20 Transfer event with exactly the signature the indexer decodes. No balances: tests only need logs.
contract TransferEmitter {
    event Transfer(address indexed from, address indexed to, uint256 value);

    function emitTransfer(address from, address to, uint256 value) external {
        emit Transfer(from, to, value);
    }
}

/// Emits the Uniswap v3 pool Swap event with the canonical signature.
contract SwapEmitter {
    event Swap(
        address indexed sender,
        address indexed recipient,
        int256 amount0,
        int256 amount1,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        int24 tick
    );

    function emitSwap(
        address sender,
        address recipient,
        int256 amount0,
        int256 amount1,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        int24 tick
    ) external {
        emit Swap(sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick);
    }
}
