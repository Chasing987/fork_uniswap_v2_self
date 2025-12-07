# Uniswap V2 架构详解：v2-core 与 v2-periphery

## 📖 目录
1. [架构概览](#架构概览)
2. [v2-core 核心层](#v2-core-核心层)
3. [v2-periphery 外围层](#v2-periphery-外围层)
4. [两者的关系与交互](#两者的关系与交互)
5. [完整交易流程](#完整交易流程)
6. [设计哲学](#设计哲学)

---

## 架构概览

Uniswap V2 采用**分层架构**设计，将系统分为两层：

```
┌─────────────────────────────────────────────────────────────┐
│                        用户/前端                              │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    v2-periphery (外围层)                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Router02     │  │ Library      │  │ Oracle       │      │
│  │ (用户接口)    │  │ (工具函数)    │  │ (价格预言机)  │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                     v2-core (核心层)                          │
│  ┌──────────────┐  ┌──────────────────────────────────┐    │
│  │ Factory      │  │ Pair (交易对池子)                  │    │
│  │ (工厂合约)    │  │ - mint (添加流动性)                │    │
│  │              │  │ - burn (移除流动性)                │    │
│  │              │  │ - swap (执行交易)                  │    │
│  └──────────────┘  └──────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### 核心设计原则

| 层级 | 职责 | 特点 | 升级性 |
|------|------|------|--------|
| **v2-core** | 核心交易逻辑、状态存储 | 简单、不可升级、Gas 优化 | ❌ 不可升级 |
| **v2-periphery** | 用户接口、安全检查、便利功能 | 复杂、可升级、用户友好 | ✅ 可升级 |

---

## v2-core 核心层

### 设计目标
- **最小化攻击面**：代码越少，漏洞越少
- **Gas 优化**：存储在链上的状态最小化
- **不可变性**：一旦部署，永久运行
- **去信任化**：无需依赖外部权限

### 核心合约结构

```
contracts/v2-core/
├── UniswapV2Factory.sol       # 工厂合约（创建交易对）
├── UniswapV2Pair.sol          # 交易对合约（核心逻辑）
├── UniswapV2ERC20.sol         # LP Token 实现
├── interfaces/                # 接口定义
│   ├── IUniswapV2Factory.sol
│   ├── IUniswapV2Pair.sol
│   └── IUniswapV2ERC20.sol
└── libraries/                 # 数学库
    ├── Math.sol               # 平方根计算
    ├── SafeMath.sol           # 安全数学运算
    └── UQ112x112.sol          # 定点数（价格累积器）
```

---

### 1. UniswapV2Factory（工厂合约）

**职责：** 创建和管理所有交易对

#### 核心代码

```solidity
contract UniswapV2Factory is IUniswapV2Factory {
    address public feeTo;              // 协议费接收地址
    address public feeToSetter;        // 费用设置权限地址
    
    // 映射：token0 => token1 => pair地址
    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;         // 所有交易对列表
    
    // Pair 合约创建码的哈希（用于 CREATE2）
    bytes32 public constant INIT_CODE_PAIR_HASH = keccak256(type(UniswapV2Pair).creationCode);

    event PairCreated(address indexed token0, address indexed token1, address pair, uint);

    constructor(address _feeToSetter) public {
        feeToSetter = _feeToSetter;
    }

    // 创建新的交易对
    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, 'UniswapV2: IDENTICAL_ADDRESSES');
        
        // 按地址大小排序（确保唯一性）
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), 'UniswapV2: ZERO_ADDRESS');
        require(getPair[token0][token1] == address(0), 'UniswapV2: PAIR_EXISTS');
        
        // 使用 CREATE2 创建合约（可预测地址）
        bytes memory bytecode = type(UniswapV2Pair).creationCode;
        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        assembly {
            pair := create2(0, add(bytecode, 32), mload(bytecode), salt)
        }
        
        IUniswapV2Pair(pair).initialize(token0, token1);
        
        // 双向映射
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;
        allPairs.push(pair);
        
        emit PairCreated(token0, token1, pair, allPairs.length);
    }
}
```

#### 关键特性

1. **CREATE2 部署**
   - 可预测的合约地址
   - 无需查询 Factory，可直接计算 Pair 地址
   - 公式：`address = keccak256(0xff, factory, salt, initCodeHash)`

2. **双向映射**
   - `getPair[token0][token1]` 和 `getPair[token1][token0]` 都指向同一个 Pair
   - 用户无需关心代币顺序

3. **协议费控制**
   - `feeTo`：如果设置，将收取 0.05% 协议费（总费用 0.3%，其中 0.25% 给 LP，0.05% 给协议）
   - `feeToSetter`：唯一可以修改 `feeTo` 的地址

---

### 2. UniswapV2Pair（交易对合约）

**职责：** 管理两个代币的流动性池，执行 swap、mint、burn 操作

#### 状态变量

```solidity
contract UniswapV2Pair is IUniswapV2Pair, UniswapV2ERC20 {
    using SafeMath  for uint;
    using UQ112x112 for uint224;

    uint public constant MINIMUM_LIQUIDITY = 10**3;  // 最小流动性锁定量

    address public factory;
    address public token0;         // 地址较小的代币
    address public token1;         // 地址较大的代币

    uint112 private reserve0;      // token0 储备量（优化 storage，使用 uint112）
    uint112 private reserve1;      // token1 储备量
    uint32  private blockTimestampLast;  // 最后更新时间戳

    uint public price0CumulativeLast;  // token1/token0 累积价格
    uint public price1CumulativeLast;  // token0/token1 累积价格
    uint public kLast;                 // reserve0 * reserve1（用于协议费计算）

    uint private unlocked = 1;
    modifier lock() {
        require(unlocked == 1, 'UniswapV2: LOCKED');
        unlocked = 0;
        _;
        unlocked = 1;
    }
}
```

#### 核心函数 1：mint（添加流动性）

```solidity
function mint(address to) external lock returns (uint liquidity) {
    (uint112 _reserve0, uint112 _reserve1,) = getReserves();
    uint balance0 = IERC20(token0).balanceOf(address(this));
    uint balance1 = IERC20(token1).balanceOf(address(this));
    uint amount0 = balance0.sub(_reserve0);  // 新增的 token0 数量
    uint amount1 = balance1.sub(_reserve1);  // 新增的 token1 数量

    bool feeOn = _mintFee(_reserve0, _reserve1);
    uint _totalSupply = totalSupply;
    
    if (_totalSupply == 0) {
        // 首次添加流动性
        liquidity = Math.sqrt(amount0.mul(amount1)).sub(MINIMUM_LIQUIDITY);
        _mint(address(0), MINIMUM_LIQUIDITY); // 永久锁定最小流动性
    } else {
        // 后续添加流动性（按比例铸造）
        liquidity = Math.min(
            amount0.mul(_totalSupply) / _reserve0, 
            amount1.mul(_totalSupply) / _reserve1
        );
    }
    
    require(liquidity > 0, 'UniswapV2: INSUFFICIENT_LIQUIDITY_MINTED');
    _mint(to, liquidity);  // 铸造 LP Token

    _update(balance0, balance1, _reserve0, _reserve1);
    if (feeOn) kLast = uint(reserve0).mul(reserve1);
    emit Mint(msg.sender, amount0, amount1);
}
```

**数学原理：**

首次添加流动性：
$$
\text{liquidity} = \sqrt{amount0 \times amount1} - \text{MINIMUM\_LIQUIDITY}
$$

后续添加流动性：
$$
\text{liquidity} = \min\left(\frac{amount0 \times totalSupply}{reserve0}, \frac{amount1 \times totalSupply}{reserve1}\right)
$$

**设计要点：**
1. **MINIMUM_LIQUIDITY 锁定**：防止通过首次添加极少流动性来操纵价格
2. **按比例铸造**：确保 LP Token 价值与池子储备成正比
3. **先转账后铸造**：调用 `mint` 前需先将代币转入 Pair 合约

---

#### 核心函数 2：burn（移除流动性）

```solidity
function burn(address to) external lock returns (uint amount0, uint amount1) {
    (uint112 _reserve0, uint112 _reserve1,) = getReserves();
    address _token0 = token0;
    address _token1 = token1;
    uint balance0 = IERC20(_token0).balanceOf(address(this));
    uint balance1 = IERC20(_token1).balanceOf(address(this));
    uint liquidity = balanceOf[address(this)];  // 待销毁的 LP Token

    bool feeOn = _mintFee(_reserve0, _reserve1);
    uint _totalSupply = totalSupply;
    
    // 按 LP Token 比例计算可赎回的代币数量
    amount0 = liquidity.mul(balance0) / _totalSupply;
    amount1 = liquidity.mul(balance1) / _totalSupply;
    
    require(amount0 > 0 && amount1 > 0, 'UniswapV2: INSUFFICIENT_LIQUIDITY_BURNED');
    
    _burn(address(this), liquidity);  // 销毁 LP Token
    _safeTransfer(_token0, to, amount0);
    _safeTransfer(_token1, to, amount1);
    
    balance0 = IERC20(_token0).balanceOf(address(this));
    balance1 = IERC20(_token1).balanceOf(address(this));

    _update(balance0, balance1, _reserve0, _reserve1);
    if (feeOn) kLast = uint(reserve0).mul(reserve1);
    emit Burn(msg.sender, amount0, amount1, to);
}
```

**数学原理：**
$$
amount0 = \frac{liquidity \times balance0}{totalSupply}
$$
$$
amount1 = \frac{liquidity \times balance1}{totalSupply}
$$

---

#### 核心函数 3：swap（执行交易）

```solidity
function swap(uint amount0Out, uint amount1Out, address to, bytes calldata data) external lock {
    require(amount0Out > 0 || amount1Out > 0, 'UniswapV2: INSUFFICIENT_OUTPUT_AMOUNT');
    (uint112 _reserve0, uint112 _reserve1,) = getReserves();
    require(amount0Out < _reserve0 && amount1Out < _reserve1, 'UniswapV2: INSUFFICIENT_LIQUIDITY');

    uint balance0;
    uint balance1;
    {
        address _token0 = token0;
        address _token1 = token1;
        require(to != _token0 && to != _token1, 'UniswapV2: INVALID_TO');
        
        // 乐观转账（先转出，后验证）
        if (amount0Out > 0) _safeTransfer(_token0, to, amount0Out);
        if (amount1Out > 0) _safeTransfer(_token1, to, amount1Out);
        
        // 闪电贷回调（如果 data 不为空）
        if (data.length > 0) IUniswapV2Callee(to).uniswapV2Call(msg.sender, amount0Out, amount1Out, data);
        
        balance0 = IERC20(_token0).balanceOf(address(this));
        balance1 = IERC20(_token1).balanceOf(address(this));
    }
    
    // 计算实际转入的代币数量
    uint amount0In = balance0 > _reserve0 - amount0Out ? balance0 - (_reserve0 - amount0Out) : 0;
    uint amount1In = balance1 > _reserve1 - amount1Out ? balance1 - (_reserve1 - amount1Out) : 0;
    require(amount0In > 0 || amount1In > 0, 'UniswapV2: INSUFFICIENT_INPUT_AMOUNT');
    
    {
        // 验证恒定乘积公式（扣除 0.3% 手续费）
        uint balance0Adjusted = balance0.mul(1000).sub(amount0In.mul(3));
        uint balance1Adjusted = balance1.mul(1000).sub(amount1In.mul(3));
        require(
            balance0Adjusted.mul(balance1Adjusted) >= uint(_reserve0).mul(_reserve1).mul(1000**2), 
            'UniswapV2: K'
        );
    }

    _update(balance0, balance1, _reserve0, _reserve1);
    emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
}
```

**核心机制：**

1. **乐观转账（Optimistic Transfer）**
   - 先转出代币，再验证 K 值
   - 支持闪电贷（Flash Swap）

2. **恒定乘积验证**
   $$
   (balance0 - 0.003 \times amount0In) \times (balance1 - 0.003 \times amount1In) \geq reserve0 \times reserve1
   $$
   
3. **0.3% 手续费**
   - 从输入代币中扣除
   - 自动累积到储备中（增加 LP Token 价值）

---

#### 辅助函数：_update（更新储备与价格累积器）

```solidity
function _update(uint balance0, uint balance1, uint112 _reserve0, uint112 _reserve1) private {
    require(balance0 <= uint112(-1) && balance1 <= uint112(-1), 'UniswapV2: OVERFLOW');
    uint32 blockTimestamp = uint32(block.timestamp % 2**32);
    uint32 timeElapsed = blockTimestamp - blockTimestampLast;
    
    if (timeElapsed > 0 && _reserve0 != 0 && _reserve1 != 0) {
        // 累积价格（用于预言机）
        price0CumulativeLast += uint(UQ112x112.encode(_reserve1).uqdiv(_reserve0)) * timeElapsed;
        price1CumulativeLast += uint(UQ112x112.encode(_reserve0).uqdiv(_reserve1)) * timeElapsed;
    }
    
    reserve0 = uint112(balance0);
    reserve1 = uint112(balance1);
    blockTimestampLast = blockTimestamp;
    emit Sync(reserve0, reserve1);
}
```

**价格累积器：** 为预言机提供 TWAP（时间加权平均价格）数据源。

---

### 3. UniswapV2ERC20（LP Token）

**职责：** 流动性提供者的凭证代币

#### 特性

```solidity
contract UniswapV2ERC20 is IUniswapV2ERC20 {
    string public constant name = 'Uniswap V2';
    string public constant symbol = 'UNI-V2';
    uint8 public constant decimals = 18;
    uint  public totalSupply;
    mapping(address => uint) public balanceOf;
    mapping(address => mapping(address => uint)) public allowance;

    // EIP-712 签名支持（permit 函数）
    bytes32 public DOMAIN_SEPARATOR;
    bytes32 public constant PERMIT_TYPEHASH = 0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9;
    mapping(address => uint) public nonces;
}
```

**关键功能：**
1. **标准 ERC20**：可转账、授权、查询余额
2. **Permit（EIP-2612）**：通过签名授权，无需单独交易

---

## v2-periphery 外围层

### 设计目标
- **用户友好**：简化复杂操作
- **安全保护**：滑点保护、截止时间检查
- **可升级性**：可部署新版本修复 bug 或添加功能
- **便利工具**：批量操作、路径查找、价格计算

### 外围合约结构

```
contracts/v2-periphery/
├── UniswapV2Router02.sol        # 路由合约（主要用户接口）
├── UniswapV2Migrator.sol        # 从 V1 迁移到 V2
├── WETH9.sol                    # ETH 包装合约
├── libraries/                   # 工具库
│   ├── UniswapV2Library.sol     # 计算工具（储备查询、价格计算）
│   ├── UniswapV2OracleLibrary.sol  # 预言机工具
│   ├── SafeMath.sol
│   └── UniswapV2LiquidityMathLibrary.sol
├── examples/                    # 示例合约
│   ├── ExampleOracleSimple.sol
│   ├── ExampleSlidingWindowOracle.sol
│   ├── ExampleFlashSwap.sol
│   └── ExampleSwapToPrice.sol
└── interfaces/                  # 接口定义
```

---

### 1. UniswapV2Router02（路由合约）

**职责：** 为用户提供高层 API，处理复杂的交互逻辑

#### 核心特性

```solidity
contract UniswapV2Router02 is IUniswapV2Router02 {
    using SafeMath for uint;

    address public immutable override factory;
    address public immutable override WETH;

    modifier ensure(uint deadline) {
        require(deadline >= block.timestamp, 'UniswapV2Router: EXPIRED');
        _;
    }

    constructor(address _factory, address _WETH) public {
        factory = _factory;
        WETH = _WETH;
    }

    receive() external payable {
        assert(msg.sender == WETH); // 仅接受来自 WETH 合约的 ETH
    }
}
```

#### 功能分类

| 功能类别 | 函数 | 说明 |
|---------|------|------|
| **添加流动性** | `addLiquidity` | 添加 ERC20/ERC20 流动性 |
|  | `addLiquidityETH` | 添加 Token/ETH 流动性 |
| **移除流动性** | `removeLiquidity` | 移除流动性 |
|  | `removeLiquidityETH` | 移除 ETH 流动性 |
|  | `removeLiquidityWithPermit` | 使用签名移除流动性 |
| **交易** | `swapExactTokensForTokens` | 精确输入交易 |
|  | `swapTokensForExactTokens` | 精确输出交易 |
|  | `swapExactETHForTokens` | ETH → Token |
|  | `swapExactTokensForETH` | Token → ETH |
| **工具** | `quote` | 根据储备计算等价金额 |
|  | `getAmountOut` | 计算输出金额 |
|  | `getAmountIn` | 计算输入金额 |
|  | `getAmountsOut` | 批量计算输出（多跳） |

---

#### 关键函数：addLiquidity

```solidity
function addLiquidity(
    address tokenA,
    address tokenB,
    uint amountADesired,    // 期望添加的 tokenA 数量
    uint amountBDesired,    // 期望添加的 tokenB 数量
    uint amountAMin,        // 最小可接受的 tokenA 数量（滑点保护）
    uint amountBMin,        // 最小可接受的 tokenB 数量（滑点保护）
    address to,             // LP Token 接收地址
    uint deadline           // 交易截止时间
) external virtual override ensure(deadline) returns (uint amountA, uint amountB, uint liquidity) {
    // 1. 计算最优添加数量
    (amountA, amountB) = _addLiquidity(tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin);
    
    // 2. 计算 pair 地址
    address pair = UniswapV2Library.pairFor(factory, tokenA, tokenB);
    
    // 3. 将代币从用户转入 pair
    TransferHelper.safeTransferFrom(tokenA, msg.sender, pair, amountA);
    TransferHelper.safeTransferFrom(tokenB, msg.sender, pair, amountB);
    
    // 4. 调用 pair.mint() 铸造 LP Token
    liquidity = IUniswapV2Pair(pair).mint(to);
}

// 内部函数：计算最优添加数量
function _addLiquidity(
    address tokenA,
    address tokenB,
    uint amountADesired,
    uint amountBDesired,
    uint amountAMin,
    uint amountBMin
) internal virtual returns (uint amountA, uint amountB) {
    // 如果 pair 不存在，创建它
    if (IUniswapV2Factory(factory).getPair(tokenA, tokenB) == address(0)) {
        IUniswapV2Factory(factory).createPair(tokenA, tokenB);
    }
    
    (uint reserveA, uint reserveB) = UniswapV2Library.getReserves(factory, tokenA, tokenB);
    
    if (reserveA == 0 && reserveB == 0) {
        // 首次添加流动性：使用期望值
        (amountA, amountB) = (amountADesired, amountBDesired);
    } else {
        // 后续添加：按现有比例计算
        uint amountBOptimal = UniswapV2Library.quote(amountADesired, reserveA, reserveB);
        if (amountBOptimal <= amountBDesired) {
            require(amountBOptimal >= amountBMin, 'UniswapV2Router: INSUFFICIENT_B_AMOUNT');
            (amountA, amountB) = (amountADesired, amountBOptimal);
        } else {
            uint amountAOptimal = UniswapV2Library.quote(amountBDesired, reserveB, reserveA);
            assert(amountAOptimal <= amountADesired);
            require(amountAOptimal >= amountAMin, 'UniswapV2Router: INSUFFICIENT_A_AMOUNT');
            (amountA, amountB) = (amountAOptimal, amountBDesired);
        }
    }
}
```

**流程：**
1. 检查 pair 是否存在，不存在则创建
2. 根据储备比例计算最优添加数量
3. 滑点保护：确保实际数量 ≥ 最小可接受数量
4. 转账 → 调用 `mint`

---

#### 关键函数：swapExactTokensForTokens

```solidity
function swapExactTokensForTokens(
    uint amountIn,              // 精确输入数量
    uint amountOutMin,          // 最小输出数量（滑点保护）
    address[] calldata path,    // 交易路径（如 [DAI, WETH, USDC]）
    address to,                 // 接收地址
    uint deadline               // 截止时间
) external virtual override ensure(deadline) returns (uint[] memory amounts) {
    // 1. 计算每一跳的输出数量
    amounts = UniswapV2Library.getAmountsOut(factory, amountIn, path);
    
    // 2. 滑点检查
    require(amounts[amounts.length - 1] >= amountOutMin, 'UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT');
    
    // 3. 将输入代币转入第一个 pair
    TransferHelper.safeTransferFrom(
        path[0], 
        msg.sender, 
        UniswapV2Library.pairFor(factory, path[0], path[1]), 
        amounts[0]
    );
    
    // 4. 执行多跳交易
    _swap(amounts, path, to);
}

// 内部函数：执行多跳交易
function _swap(uint[] memory amounts, address[] memory path, address _to) internal virtual {
    for (uint i; i < path.length - 1; i++) {
        (address input, address output) = (path[i], path[i + 1]);
        (address token0,) = UniswapV2Library.sortTokens(input, output);
        uint amountOut = amounts[i + 1];
        
        // 根据排序确定输出方向
        (uint amount0Out, uint amount1Out) = input == token0 ? (uint(0), amountOut) : (amountOut, uint(0));
        
        // 中间跳：输出到下一个 pair；最后一跳：输出到用户地址
        address to = i < path.length - 2 ? UniswapV2Library.pairFor(factory, output, path[i + 2]) : _to;
        
        // 调用 pair.swap()
        IUniswapV2Pair(UniswapV2Library.pairFor(factory, input, output)).swap(
            amount0Out, amount1Out, to, new bytes(0)
        );
    }
}
```

**多跳交易示例：**
```
用户发起：DAI → WETH → USDC
path = [DAI, WETH, USDC]

第1跳：DAI → WETH
- 输入：100 DAI 到 DAI/WETH pair
- 输出：0.05 WETH 到 WETH/USDC pair

第2跳：WETH → USDC
- 输入：0.05 WETH（已在 pair 中）
- 输出：95 USDC 到用户地址
```

---

### 2. UniswapV2Library（工具库）

**职责：** 提供链下可调用的计算函数

#### 核心函数

```solidity
library UniswapV2Library {
    using SafeMath for uint;

    // 排序代币地址
    function sortTokens(address tokenA, address tokenB) internal pure returns (address token0, address token1) {
        require(tokenA != tokenB, 'UniswapV2Library: IDENTICAL_ADDRESSES');
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), 'UniswapV2Library: ZERO_ADDRESS');
    }

    // 计算 pair 地址（CREATE2）
    function pairFor(address factory, address tokenA, address tokenB) internal pure returns (address pair) {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        pair = address(uint(keccak256(abi.encodePacked(
                hex'ff',
                factory,
                keccak256(abi.encodePacked(token0, token1)),
                hex'215a032792ab9f4a5eb14f1f4c1daed5017b1eee4de72ddb42e06c967b16c5d4' // init code hash
            ))));
    }

    // 获取储备量
    function getReserves(address factory, address tokenA, address tokenB) internal view returns (uint reserveA, uint reserveB) {
        (address token0,) = sortTokens(tokenA, tokenB);
        (uint reserve0, uint reserve1,) = IUniswapV2Pair(pairFor(factory, tokenA, tokenB)).getReserves();
        (reserveA, reserveB) = tokenA == token0 ? (reserve0, reserve1) : (reserve1, reserve0);
    }

    // 根据输入计算输出（单跳）
    function getAmountOut(uint amountIn, uint reserveIn, uint reserveOut) internal pure returns (uint amountOut) {
        require(amountIn > 0, 'UniswapV2Library: INSUFFICIENT_INPUT_AMOUNT');
        require(reserveIn > 0 && reserveOut > 0, 'UniswapV2Library: INSUFFICIENT_LIQUIDITY');
        
        uint amountInWithFee = amountIn.mul(997);  // 扣除 0.3% 手续费
        uint numerator = amountInWithFee.mul(reserveOut);
        uint denominator = reserveIn.mul(1000).add(amountInWithFee);
        amountOut = numerator / denominator;
    }

    // 根据输出计算输入（单跳）
    function getAmountIn(uint amountOut, uint reserveIn, uint reserveOut) internal pure returns (uint amountIn) {
        require(amountOut > 0, 'UniswapV2Library: INSUFFICIENT_OUTPUT_AMOUNT');
        require(reserveIn > 0 && reserveOut > 0, 'UniswapV2Library: INSUFFICIENT_LIQUIDITY');
        
        uint numerator = reserveIn.mul(amountOut).mul(1000);
        uint denominator = reserveOut.sub(amountOut).mul(997);
        amountIn = (numerator / denominator).add(1);
    }

    // 计算多跳输出
    function getAmountsOut(address factory, uint amountIn, address[] memory path) internal view returns (uint[] memory amounts) {
        require(path.length >= 2, 'UniswapV2Library: INVALID_PATH');
        amounts = new uint[](path.length);
        amounts[0] = amountIn;
        for (uint i; i < path.length - 1; i++) {
            (uint reserveIn, uint reserveOut) = getReserves(factory, path[i], path[i + 1]);
            amounts[i + 1] = getAmountOut(amounts[i], reserveIn, reserveOut);
        }
    }
}
```

**数学公式（恒定乘积 AMM）：**

输出计算：
$$
amountOut = \frac{amountIn \times 0.997 \times reserveOut}{reserveIn + amountIn \times 0.997}
$$

输入计算：
$$
amountIn = \frac{reserveIn \times amountOut}{(reserveOut - amountOut) \times 0.997} + 1
$$

---

## 两者的关系与交互

### 调用链路

```
用户/前端
    ↓
Router02.addLiquidity()          [v2-periphery]
    ↓
1. 计算最优数量 (_addLiquidity)
2. 转账到 Pair (TransferHelper)
    ↓
Pair.mint()                      [v2-core]
    ↓
1. 计算 liquidity
2. 铸造 LP Token (_mint)
3. 更新储备 (_update)
    ↓
返回 liquidity 给用户
```

### 职责划分

| 操作 | v2-core | v2-periphery |
|------|---------|--------------|
| **创建 Pair** | Factory 创建 | Router 触发 Factory |
| **添加流动性** | Pair.mint() 铸造 LP | Router 计算数量 + 转账 |
| **移除流动性** | Pair.burn() 销毁 LP | Router 计算数量 + 转账 |
| **交易** | Pair.swap() 执行 | Router 计算路径 + 多跳 |
| **价格计算** | 提供储备数据 | Library 计算价格 |
| **滑点保护** | ❌ 无 | ✅ Router 检查 |
| **截止时间** | ❌ 无 | ✅ Router 检查 |
| **ETH 支持** | ❌ 仅 ERC20 | ✅ Router 包装/解包 WETH |

---

## 完整交易流程

### 场景：用户用 100 DAI 交换 USDC

#### 1. 前端准备
```javascript
// 1. 查询最佳路径（假设 DAI → WETH → USDC 最优）
const path = [DAI_ADDRESS, WETH_ADDRESS, USDC_ADDRESS];

// 2. 计算预期输出
const amounts = await router.getAmountsOut(ethers.parseUnits("100", 18), path);
const expectedUSDC = amounts[2]; // 约 95 USDC

// 3. 设置滑点容忍度（1%）
const amountOutMin = expectedUSDC * 99n / 100n; // 94.05 USDC

// 4. 设置截止时间（10 分钟）
const deadline = Math.floor(Date.now() / 1000) + 600;
```

#### 2. 用户授权
```javascript
// 授权 Router 划转 DAI
await dai.approve(router.address, ethers.parseUnits("100", 18));
```

#### 3. 执行交易
```javascript
await router.swapExactTokensForTokens(
    ethers.parseUnits("100", 18),  // amountIn
    amountOutMin,                   // amountOutMin
    path,                           // path
    userAddress,                    // to
    deadline                        // deadline
);
```

#### 4. 内部执行流程

```
Router.swapExactTokensForTokens()
    ↓
1. 计算每一跳输出
   amounts = [100 DAI, 0.05 WETH, 95 USDC]
    ↓
2. 滑点检查
   require(95 >= 94.05) ✅
    ↓
3. 转账 100 DAI 到 DAI/WETH Pair
    ↓
4. 第一跳：Pair.swap(0, 0.05 WETH, WETH/USDC Pair, "")
   - 验证 K 值
   - 转出 0.05 WETH 到 WETH/USDC Pair
    ↓
5. 第二跳：Pair.swap(0, 95 USDC, userAddress, "")
   - 验证 K 值
   - 转出 95 USDC 到用户地址
    ↓
返回 amounts = [100, 0.05, 95]
```

---

## 设计哲学

### 1. 为什么分层？

| 原因 | 说明 |
|------|------|
| **安全性** | 核心层代码最少，攻击面最小 |
| **可升级性** | 外围层可迭代更新，核心层不变 |
| **Gas 优化** | 核心层极致优化，外围层更注重易用性 |
| **灵活性** | 可部署多个不同版本的 Router，共享同一个 Core |

### 2. 核心层设计原则

1. **最小权限**
   - 无 owner 角色
   - 无暂停开关
   - 无升级机制

2. **去信任化**
   - 所有逻辑通过数学验证（K 值）
   - 无需信任第三方

3. **Gas 优化**
   - 使用 `uint112` 紧凑存储
   - 单个 storage slot 存储 `reserve0`, `reserve1`, `blockTimestampLast`
   - 内联汇编（CREATE2）

### 3. 外围层设计原则

1. **用户友好**
   - 自动处理代币排序
   - 自动创建 Pair
   - 支持 ETH（自动包装/解包）

2. **安全保护**
   - 滑点保护（`amountMin`）
   - 截止时间检查（`deadline`）
   - 路径验证

3. **可扩展性**
   - 支持多跳路由
   - 支持闪电贷
   - 支持批量操作

---

## 总结对比表

| 特性 | v2-core | v2-periphery |
|------|---------|--------------|
| **代码量** | ~500 行 | ~2000 行 |
| **复杂度** | 低 | 高 |
| **可升级** | ❌ | ✅ |
| **直接调用** | 不推荐（需手动计算） | 推荐（简单易用） |
| **Gas 成本** | 低 | 稍高（增加安全检查） |
| **安全性** | 基础（依赖数学验证） | 增强（滑点/截止时间保护） |
| **功能** | 最小集合（mint/burn/swap） | 完整集合（多跳/ETH/工具） |
| **依赖** | 无外部依赖 | 依赖 core 层 |

---

## 最佳实践

### 作为用户/前端开发者
✅ **应该：**
- 使用 Router02 进行所有操作
- 设置合理的滑点容忍度（0.5% - 2%）
- 设置合理的截止时间（5-10 分钟）
- 使用 `getAmountsOut` 预估输出

❌ **不应该：**
- 直接调用 Pair 合约（除非你完全理解底层逻辑）
- 忽略滑点保护
- 设置过长的截止时间

### 作为协议开发者
✅ **可以：**
- 直接调用 Pair.swap() 实现闪电贷
- 继承 Router02 添加自定义逻辑
- 使用 Library 进行链下计算

❌ **禁止：**
- 假设 Core 层有权限控制
- 依赖 Core 层的任何可变状态（除了储备量）

---

**文档生成时间：** 2025年12月7日  
**项目路径：** `/Users/lyf/web3/fork_uniswapv2/fork_uniswap_v2_self`  
**相关文档：** [Uniswap V2 预言机详解](./Uniswap_V2_Oracle.md)
