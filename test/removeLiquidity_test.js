const { ethers } = require("hardhat");
const hre = require("hardhat");
const { addLiquidity } = require("./addLiquidity_test");
const { deployUniswap } = require("./utils/deployFactory");
const { deployToken } = require("./utils/deployToken");
const { createPair } = require("./addLiquidity_test");
const { expect } = require("chai");
const {
  abi: pairAbi,
} = require("../artifacts/contracts/v2-core/UniswapV2Pair.sol/UniswapV2Pair.json");

async function removeLiquidity(routerContract, factory, token1, token2) {
  const [signer] = await ethers.getSigners();
  //获取uniswapV2Router合约

  //检查用户在tokne1和token2上的余额
  const balanceOf1 = await token1.balanceOf(signer.address);
  const balanceOf2 = await token2.balanceOf(signer.address);
  console.log("token1 balanceOf1 ", balanceOf1);
  console.log("token2 balanceOf2 ", balanceOf2);

  //设置100s超时
  let deadline = Math.round(new Date().getTime() / 1000) + 100;

  // 找到pair合约(LP代币合约)
  // 通过工厂检查用户账户LP代币余额(liquidity)

  const pair = await hre.ethers.getContractAt(
    pairAbi,
    await factory.getPair(
      await token1.getAddress(),
      await token2.getAddress(),
      signer
    )
  );

  // LP代币余额
  const liquidity = await pair.balanceOf(signer.address);

  // 设置最小提取数量，有滑点限制时设置，这里不考虑滑点限制，设置为0
  const AMOUNT_MIN = 0;

  const amountAMin = AMOUNT_MIN;
  const amountBMin = AMOUNT_MIN;

  // 授权router划拨自己的LP代币
  await pair.approve(await routerContract.getAddress(), liquidity);

  let token1Address = await token1.getAddress();
  let token2Address = await token2.getAddress();
  //移除流动性
  await routerContract.removeLiquidity(
    token1Address,
    token2Address,
    liquidity,
    amountAMin,
    amountBMin,
    signer.address,
    deadline
  );

  //通过工厂检查pair合约余额
  const reservers = await pair.getReserves();

  //在uniswapv2中 pair会进行排序
  if (token1Address < token2Address) {
    console.log(
      "checking pair reverse token1=%s,token2=%s",
      reservers[0],
      reservers[1]
    );
  } else {
    console.log(
      "checking pair reverse token1=%s,token2=%s",
      reservers[1],
      reservers[0]
    );
  }
  // 检查移除流动性后用户在pair上的余额:LP代币余额
  console.log("pair balanceOf", await pair.balanceOf(signer.address));

  //检查移除流动性后用户在tokne1和token2上的余额
  console.log(
    "token1 balanceOf1 after removed liquidity",
    await token1.balanceOf(signer.address)
  );
  console.log(
    "token2 balanceOf2 after removed liquidity",
    await token2.balanceOf(signer.address)
  );
  return pair.balanceOf(signer.address);
}

describe("remove Liquidity", function () {
  it("remove liquidity success", async function () {
    [signer] = await ethers.getSigners();
    //first deploy factory
    [router, factory, weth] = await deployUniswap();
    //second deploy tokens
    [token1, token2] = await deployToken("1000", "3000");
    await createPair(signer, factory, token1, token2);
    await addLiquidity(signer, router, token1, token2, "100", "200");
    let currentLp = await removeLiquidity(router, factory, token1, token2);
    expect(currentLp).to.eq(0);
  });
});
