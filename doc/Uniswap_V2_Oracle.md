# Uniswap V2 预言机（Price Oracle）详解

## 📖 目录
1. [什么是预言机](#什么是预言机)
2. [为什么需要预言机](#为什么需要预言机)
3. [Uniswap V2 预言机原理](#uniswap-v2-预言机原理)
4. [核心实现](#核心实现)
5. [两种预言机实现](#两种预言机实现)
6. [使用示例](#使用示例)
7. [安全注意事项](#安全注意事项)

---

## 什么是预言机

**预言机（Oracle）** 是区块链系统从外部获取可信数据的机制。在 DeFi 中，**价格预言机**用于提供代币的市场价格，以供其他智能合约（如借贷协议、衍生品合约）使用。

### Uniswap V2 预言机的特点
- **链上数据源**：利用 Uniswap 交易对的储备量计算价格
- **时间加权平均价格（TWAP）**：防止瞬时价格操纵
- **去中心化**：无需外部数据源，完全基于链上数据
- **抗操纵**：通过时间加权机制增加攻击成本

---

## 为什么需要预言机

### 问题：即时价格易被操纵
如果直接使用 `reserve1/reserve0` 计算当前价格，攻击者可以：
1. 通过闪电贷借入大量代币
2. 在 Uniswap 进行巨额交易，瞬间推高/压低价格
3. 利用操纵后的价格在其他协议套利
4. 归还闪电贷，完成攻击

### 解决方案：时间加权平均价格（TWAP）
- 计算一段时间内的**平均价格**，而非瞬时价格
- 攻击者需要在多个区块内持续操纵价格，成本极高
- 提供更稳定、可靠的价格参考

---

## Uniswap V2 预言机原理

### 核心概念：价格累积器（Price Accumulator）

Uniswap V2 Pair 合约维护两个价格累积变量：

```solidity
uint public price0CumulativeLast;  // token1/token0 的累积价格
uint public price1CumulativeLast;  // token0/token1 的累积价格
```

#### 累积价格计算公式

每次调用 `mint`、`burn` 或 `swap` 时，会触发 `_update` 函数更新累积价格：

```solidity
function _update(uint balance0, uint balance1, uint112 _reserve0, uint112 _reserve1) private {
    uint32 blockTimestamp = uint32(block.timestamp % 2**32);
    uint32 timeElapsed = blockTimestamp - blockTimestampLast;
    
    if (timeElapsed > 0 && _reserve0 != 0 && _reserve1 != 0) {
        // 累积价格 += 当前价格 × 时间间隔
        price0CumulativeLast += uint(UQ112x112.encode(_reserve1).uqdiv(_reserve0)) * timeElapsed;
        price1CumulativeLast += uint(UQ112x112.encode(_reserve0).uqdiv(_reserve1)) * timeElapsed;
    }
    
    reserve0 = uint112(balance0);
    reserve1 = uint112(balance1);
    blockTimestampLast = blockTimestamp;
    emit Sync(reserve0, reserve1);
}
```

#### 数学原理

$$
\text{price0Cumulative}_t = \text{price0Cumulative}_{t-1} + \frac{\text{reserve1}}{\text{reserve0}} \times \Delta t
$$

**时间加权平均价格（TWAP）计算：**

$$
\text{TWAP} = \frac{\text{price0Cumulative}_{\text{end}} - \text{price0Cumulative}_{\text{start}}}{\text{time}_{\text{end}} - \text{time}_{\text{start}}}
$$

---

## 核心实现

### 1. UniswapV2OracleLibrary（基础库）

位置：`contracts/v2-periphery/libraries/UniswapV2OracleLibrary.sol`

```solidity
library UniswapV2OracleLibrary {
    using FixedPoint for *;

    // 获取当前区块时间戳（uint32 范围）
    function currentBlockTimestamp() internal view returns (uint32) {
        return uint32(block.timestamp % 2 ** 32);
    }

    // 获取当前累积价格（考虑时间流逝的反事实价格）
    function currentCumulativePrices(
        address pair
    ) internal view returns (uint price0Cumulative, uint price1Cumulative, uint32 blockTimestamp) {
        blockTimestamp = currentBlockTimestamp();
        price0Cumulative = IUniswapV2Pair(pair).price0CumulativeLast();
        price1Cumulative = IUniswapV2Pair(pair).price1CumulativeLast();

        // 如果自上次更新后时间已流逝，模拟累积价格值
        (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast) = IUniswapV2Pair(pair).getReserves();
        if (blockTimestampLast != blockTimestamp) {
            uint32 timeElapsed = blockTimestamp - blockTimestampLast;
            // 反事实累积：假设储备量未变，继续累积
            price0Cumulative += uint(FixedPoint.fraction(reserve1, reserve0)._x) * timeElapsed;
            price1Cumulative += uint(FixedPoint.fraction(reserve0, reserve1)._x) * timeElapsed;
        }
    }
}
```

**关键点：**
- `currentCumulativePrices` 返回"反事实"价格：即使 pair 未更新，也模拟当前时刻的累积价格
- 使用 **UQ112x112 定点数**格式存储价格，避免精度损失

---

## 两种预言机实现

项目中提供了两种预言机示例实现：

### 1. ExampleOracleSimple（固定窗口预言机）

**位置：** `contracts/v2-periphery/examples/ExampleOracleSimple.sol`

#### 特点
- **固定时间窗口**：每 24 小时更新一次平均价格
- **简单实现**：每个交易对需部署一个预言机合约
- **适用场景**：对价格更新频率要求不高的场景

#### 核心代码

```solidity
contract ExampleOracleSimple {
    using FixedPoint for *;

    uint public constant PERIOD = 24 hours;  // 固定周期

    IUniswapV2Pair immutable pair;
    address public immutable token0;
    address public immutable token1;

    uint    public price0CumulativeLast;
    uint    public price1CumulativeLast;
    uint32  public blockTimestampLast;
    FixedPoint.uq112x112 public price0Average;  // 平均价格
    FixedPoint.uq112x112 public price1Average;

    // 初始化：记录初始累积价格
    constructor(address factory, address tokenA, address tokenB) public {
        IUniswapV2Pair _pair = IUniswapV2Pair(UniswapV2Library.pairFor(factory, tokenA, tokenB));
        pair = _pair;
        token0 = _pair.token0();
        token1 = _pair.token1();
        price0CumulativeLast = _pair.price0CumulativeLast();
        price1CumulativeLast = _pair.price1CumulativeLast();
        uint112 reserve0;
        uint112 reserve1;
        (reserve0, reserve1, blockTimestampLast) = _pair.getReserves();
        require(reserve0 != 0 && reserve1 != 0, 'ExampleOracleSimple: NO_RESERVES');
    }

    // 更新平均价格（至少间隔 PERIOD）
    function update() external {
        (uint price0Cumulative, uint price1Cumulative, uint32 blockTimestamp) =
            UniswapV2OracleLibrary.currentCumulativePrices(address(pair));
        uint32 timeElapsed = blockTimestamp - blockTimestampLast;

        require(timeElapsed >= PERIOD, 'ExampleOracleSimple: PERIOD_NOT_ELAPSED');

        // 计算平均价格 = (累积价格差) / 时间间隔
        price0Average = FixedPoint.uq112x112(uint224((price0Cumulative - price0CumulativeLast) / timeElapsed));
        price1Average = FixedPoint.uq112x112(uint224((price1Cumulative - price1CumulativeLast) / timeElapsed));

        price0CumulativeLast = price0Cumulative;
        price1CumulativeLast = price1Cumulative;
        blockTimestampLast = blockTimestamp;
    }

    // 查询：根据输入数量计算输出数量
    function consult(address token, uint amountIn) external view returns (uint amountOut) {
        if (token == token0) {
            amountOut = price0Average.mul(amountIn).decode144();
        } else {
            require(token == token1, 'ExampleOracleSimple: INVALID_TOKEN');
            amountOut = price1Average.mul(amountIn).decode144();
        }
    }
}
```

#### 使用流程

```javascript
// 1. 部署预言机（针对 ETH/DAI 交易对）
const oracle = await ExampleOracleSimple.deploy(factory.address, weth.address, dai.address);

// 2. 每 24 小时调用一次 update
await oracle.update();  // 初次更新需要等待 24 小时

// 3. 查询价格：1 ETH 能换多少 DAI
const daiAmount = await oracle.consult(weth.address, ethers.parseUnits("1", 18));
console.log("1 ETH =", ethers.formatUnits(daiAmount, 18), "DAI");
```

---

### 2. ExampleSlidingWindowOracle（滑动窗口预言机）

**位置：** `contracts/v2-periphery/examples/ExampleSlidingWindowOracle.sol`

#### 特点
- **滑动窗口**：维护多个观测点，提供更精确的移动平均价格
- **单例模式**：一个合约可服务多个交易对
- **可配置精度**：通过 `granularity` 控制观测点数量
- **适用场景**：需要高精度、频繁更新价格的场景

#### 核心参数

```solidity
contract ExampleSlidingWindowOracle {
    // 窗口大小（如 24 小时）
    uint public immutable windowSize;
    
    // 粒度（观测点数量）
    // 粒度越高，精度越高，但更新频率需求也越高
    uint8 public immutable granularity;
    
    // 周期大小 = windowSize / granularity
    uint public immutable periodSize;
    
    // 每个交易对的观测记录
    mapping(address => Observation[]) public pairObservations;
    
    struct Observation {
        uint timestamp;
        uint price0Cumulative;
        uint price1Cumulative;
    }
}
```

#### 核心代码

```solidity
constructor(address factory_, uint windowSize_, uint8 granularity_) public {
    require(granularity_ > 1, 'SlidingWindowOracle: GRANULARITY');
    require(
        (periodSize = windowSize_ / granularity_) * granularity_ == windowSize_,
        'SlidingWindowOracle: WINDOW_NOT_EVENLY_DIVISIBLE'
    );
    factory = factory_;
    windowSize = windowSize_;
    granularity = granularity_;
}

// 更新观测点（每个周期最多更新一次）
function update(address tokenA, address tokenB) external {
    address pair = UniswapV2Library.pairFor(factory, tokenA, tokenB);

    // 首次调用：初始化观测数组
    for (uint i = pairObservations[pair].length; i < granularity; i++) {
        pairObservations[pair].push();
    }

    uint8 observationIndex = observationIndexOf(block.timestamp);
    Observation storage observation = pairObservations[pair][observationIndex];

    uint timeElapsed = block.timestamp - observation.timestamp;
    if (timeElapsed > periodSize) {
        (uint price0Cumulative, uint price1Cumulative,) = UniswapV2OracleLibrary.currentCumulativePrices(pair);
        observation.timestamp = block.timestamp;
        observation.price0Cumulative = price0Cumulative;
        observation.price1Cumulative = price1Cumulative;
    }
}

// 查询移动平均价格
function consult(address tokenIn, uint amountIn, address tokenOut) external view returns (uint amountOut) {
    address pair = UniswapV2Library.pairFor(factory, tokenIn, tokenOut);
    Observation storage firstObservation = getFirstObservationInWindow(pair);

    uint timeElapsed = block.timestamp - firstObservation.timestamp;
    require(timeElapsed <= windowSize, 'SlidingWindowOracle: MISSING_HISTORICAL_OBSERVATION');

    (uint price0Cumulative, uint price1Cumulative,) = UniswapV2OracleLibrary.currentCumulativePrices(pair);
    (address token0,) = UniswapV2Library.sortTokens(tokenIn, tokenOut);

    if (token0 == tokenIn) {
        return computeAmountOut(firstObservation.price0Cumulative, price0Cumulative, timeElapsed, amountIn);
    } else {
        return computeAmountOut(firstObservation.price1Cumulative, price1Cumulative, timeElapsed, amountIn);
    }
}
```

#### 使用流程

```javascript
// 1. 部署滑动窗口预言机（24 小时窗口，24 个观测点）
const windowSize = 24 * 3600;  // 24 hours
const granularity = 24;
const oracle = await ExampleSlidingWindowOracle.deploy(factory.address, windowSize, granularity);

// 2. 每小时更新一次（periodSize = 24h / 24 = 1h）
setInterval(async () => {
    await oracle.update(weth.address, dai.address);
}, 3600 * 1000);

// 3. 查询移动平均价格
const daiAmount = await oracle.consult(weth.address, ethers.parseUnits("1", 18), dai.address);
console.log("1 ETH ≈", ethers.formatUnits(daiAmount, 18), "DAI (24h TWAP)");
```

---

## 使用示例

### 场景：借贷协议使用 Uniswap 预言机

```solidity
// 借贷协议合约
contract LendingProtocol {
    ExampleOracleSimple public priceOracle;
    
    // 计算抵押品价值（以 DAI 计价）
    function getCollateralValue(address token, uint amount) public view returns (uint daiValue) {
        // 使用预言机获取 TWAP 价格
        daiValue = priceOracle.consult(token, amount);
    }
    
    // 检查是否需要清算
    function isLiquidatable(address borrower) public view returns (bool) {
        uint collateralValue = getCollateralValue(collateralToken, collateralAmount[borrower]);
        uint debtValue = debtAmount[borrower];
        
        // 抵押率低于 150% 触发清算
        return collateralValue * 100 < debtValue * 150;
    }
}
```

---

## 安全注意事项

### ⚠️ 潜在风险

1. **流动性不足**
   - 低流动性池子的价格易被操纵
   - **防护措施**：仅使用高流动性交易对（如 ETH/USDC）

2. **历史数据缺失**
   - 初次部署或长时间未更新，查询会失败
   - **防护措施**：检查 `timeElapsed` 是否在合理范围内

3. **跨区块攻击**
   - 攻击者可在多个区块内持续操纵价格（成本高但可能）
   - **防护措施**：使用较长时间窗口（如 24 小时）

4. **精度损失**
   - UQ112x112 定点数格式有精度限制
   - **防护措施**：对极小或极大价格进行边界检查

### ✅ 最佳实践

1. **定期更新**：自动化调用 `update()` 函数
2. **多源验证**：结合多个预言机（Chainlink、Band Protocol）
3. **价格边界检查**：设置合理的价格上下限
4. **监控异常**：实时监控价格偏离程度

---

## 总结

| 特性 | ExampleOracleSimple | ExampleSlidingWindowOracle |
|------|---------------------|----------------------------|
| **部署方式** | 每个交易对一个合约 | 单例合约支持多个交易对 |
| **时间窗口** | 固定 24 小时 | 可配置（如 24 小时） |
| **更新频率** | 每 24 小时 | 可配置（如每小时） |
| **精度** | 中等 | 高（通过 granularity 控制） |
| **Gas 成本** | 低 | 中等（需维护多个观测点） |
| **复杂度** | 简单 | 中等 |
| **适用场景** | 低频价格查询 | 高频、高精度价格查询 |

### 核心要点

1. **Uniswap V2 预言机利用链上交易对的储备量，通过时间加权平均价格（TWAP）提供抗操纵的价格数据**
2. **价格累积器每次交易时自动更新，记录价格 × 时间的累积值**
3. **预言机合约通过计算两个时间点的累积价格差，除以时间间隔，得到平均价格**
4. **适合作为 DeFi 协议的价格参考，但需注意流动性、更新频率等风险**

---

**文档生成时间：** 2025年12月7日  
**项目路径：** `/Users/lyf/web3/fork_uniswapv2/fork_uniswap_v2_self`
