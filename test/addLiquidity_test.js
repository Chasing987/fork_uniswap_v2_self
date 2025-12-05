const { ethers } = require("hardhat");
const hre = require("hardhat");
const { expect } = require("chai");

const {
  abi: pairAbi,
} = require("../artifacts/contracts/v2-core/UniswapV2Pair.sol/UniswapV2Pair.json");
const { deployUniswap } = require("./utils/deployFactory");
const { deployToken } = require("./utils/deployToken");

async function createPair(signer, factory, token1, token2) {
  //token1和token2 在uniswap2 中创建pair
  //通过工厂检查pair合约余额
  await factory.createPair(token1.getAddress(), await token2.getAddress());
  console.log("factory contract address is %s", await factory.getAddress());
  console.log("token1 contract address is %s", await token1.getAddress());
  console.log("token2 contract address is %s", await token2.getAddress());
}

async function addLiquidity(
  signer,
  routerContract,
  token1,
  token2,
  token1Amount,
  token2Amount
) {
  //token1和token2 在uniswap2 中创建pair
  //通过工厂检查pair合约余额
  const token1Address = await token1.getAddress();
  const token2Address = await token2.getAddress();
  console.log("factory contract address is %s", await factory.getAddress());
  console.log("token1 contract address is %s", token1Address);
  console.log("token2 contract address is %s", token2Address);

  //授权swap划拨自己的token1和token2
  let tokenOneLiquidityAmount = ethers.parseUnits(token1Amount, 18);
  let tokenTwoLiquidityAmount = ethers.parseUnits(token2Amount, 18);

  await token1.approve(routerContract, tokenOneLiquidityAmount);
  await token2.approve(routerContract, tokenTwoLiquidityAmount);
  //检查swaprouter是否具备足够多的allowance
  const allowance1 = await token1.allowance(signer.address, routerContract);
  const allowance2 = await token2.allowance(signer.address, routerContract);
  console.log("token1 allowance ", allowance1);
  console.log("token2 allowance ", allowance2);

  //检查用户在tokne1和token2上的余额
  balanceOf1 = await token1.balanceOf(signer.address);
  balanceOf2 = await token2.balanceOf(signer.address);
  console.log("token1 balanceOf1 ", balanceOf1);
  console.log("token2 balanceOf2 ", balanceOf2);

  //设置100s超时
  let deadline = Math.round(new Date().getTime() / 1000) + 100;
  //添加流动性
  await routerContract.addLiquidity(
    token1Address,
    token2Address,
    tokenOneLiquidityAmount,
    tokenTwoLiquidityAmount,
    0,
    0,
    signer.address,
    deadline
  );
}

async function checkReserves(signer, factory, token1, token2) {
  const pair = await hre.ethers.getContractAt(
    pairAbi,
    await factory.getPair(
      await token1.getAddress(),
      await token2.getAddress(),
      signer
    )
  );
  let reserves = await pair.getReserves();

  let reserves0;
  let reserves1;
  //在uniswapv2中 pair会进行排序
  if ((await token1.getAddress()) < (await token2.getAddress())) {
    reserves0 = reserves[0];
    reserves1 = reserves[1];
    console.log(
      "checking pair reverse token1=%s,token2=%s",
      reserves[0],
      reserves[1]
    );
  } else {
    reserves0 = reserves[1];
    reserves1 = reserves[0];
    console.log(
      "checking pair reverse token1=%s,token2=%s",
      reserves[1],
      reserves[0]
    );
  }
  expect(reserves0).eq(ethers.parseUnits("100"));
  expect(reserves1).eq(ethers.parseUnits("200"));
}

describe("add Liquidity", function () {
  it("create pair success,pair lenght eq 1", async function () {
    [signer] = await ethers.getSigners();
    //first deploy factory
    [router, factory, weth] = await deployUniswap();
    //second deploy tokens
    [token1, token2] = await deployToken("1000", "3000");
    console.log("token1=>", await token1.getAddress());
    console.log("token2=>", await token2.getAddress());
    await createPair(signer, factory, token1, token2);
    //查看pair对创建结果
    console.log("pair length", await factory.allPairsLength());
    expect(await factory.allPairsLength()).eq(1);
  });
  it("add liquidity success", async function () {
    [signer] = await ethers.getSigners();
    //first deploy factory
    [router, factory, weth] = await deployUniswap();
    //second deploy tokens
    [token1, token2] = await deployToken("1000", "3000");
    await createPair(signer, factory, token1, token2);
    await addLiquidity(signer, router, token1, token2, "100", "200");
    await checkReserves(signer, factory, token1, token2);
  });
});

module.exports = {
  addLiquidity,
  createPair,
};
