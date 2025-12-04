# Fork 流程记录

1. 新建一个目录fork_uniswapv2
2. 将v2-core和v2-periphery项目通过git clone克隆下来
3. 在fork_uniswapv2目录底下创建一个新的目录fork_uniswap_v2_self
4. `cd fork_uniswap_v2_self`进入该目录下，初始化为hardhat项目

```shell
# 初始化一个新的 Node.js 项目，创建一个 package.json 文件,这是 Node.js 项目的配置文件,包含项目名称、版本、依赖等信息
yarn init -y

# 使用 Yarn 包管理器安装 Hardhat 作为开发依赖的命令
yarn add -D hardhat

# 初始化一个新的 Hardhat 项目
npx hardhat init
```

5. `cd ~/web3/fork_uniswapv2/fork_uniswap_v2_self/contracts/v2-core` 进入之前从github克隆的项目下
6. 复制项目中的合约至 `/Users/lyf/web3/fork_uniswapv2/fork_uniswap_v2_self/contracts/v2-core`

```shell
cp -r contracts/* /Users/lyf/web3/fork_uniswapv2/fork_uniswap_v2_self/contracts/v2-core
```

7. `cd ~/web3/fork_uniswapv2/fork_uniswap_v2_self/contracts` 目录下，同时更改`hardhat.config.js`中的solidity版本
8. 编译合约

```shell
npx hardhat compile
```

9. 部署合约

```shell
npx hardhat run scripts/deploy.js
```

10. 接下来fork v2-periphery
11. `cd ~/web3/fork_uniswapv2/v2-periphery`，然后执行复制操作

```shell
cp -r contracts/* /Users/lyf/web3/fork_uniswapv2/fork_uniswap_v2_self/contracts/v2-periphery
```

12. `cd /Users/lyf/web3/fork_uniswapv2/fork_uniswap_v2_self `，然后执行 `npx hardhat compile`，会发现有Solidtity的版本问题，这个时候采用Solidtity的多版本

```solidity
solidity: {
    compilers: [
      {
        version: "0.5.16",
      },
      {
        version: "0.6.6",
        settings: {},
      },
    ],
  }
```

同时，需要添加`WETH9`合约，添加完之后需要改造一下其中报错的地方，这是由于solidity的版本的问题导致的，根据报红来解决相应的问题。

13. 然后，需要运行下面的命令安装依赖

```shell
npm install --save-dev @uniswap/lib 

npm install --save-dev @uniswap/v2-core 
```

14. 最终部署合约脚本

```shell
npx hardhat run scripts/deploy.js
```

