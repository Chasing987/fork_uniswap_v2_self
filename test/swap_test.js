const { ethers } = require("hardhat");
const { addLiquidity } = require("./addLiquidity_test");
const { createPair } = require("./addLiquidity_test");
const { deployUniswap } = require("./utils/deployFactory");
const { deployToken } = require("./utils/deployToken");
const { quote } = require("./quote_test");
const { expect } = require("chai");
let amountInNum = "5";
async function swap(routerContract, token1, token2, amountInNum) {
  const amountIn = ethers.parseUnits(amountInNum, 18);
  const [signer] = await ethers.getSigners();

  await token1.approve(await routerContract.getAddress(), amountIn);
  //100s超时
  let deadline = Math.round(new Date().getTime() / 1000) + 100;
  console.log(`Check Balance before swap token1 ${amountIn}`);
  console.log("balance of token1 ", await token1.balanceOf(signer.address));
  console.log("balance of token2 ", await token2.balanceOf(signer.address));
  //执行兑换
  await routerContract.swapExactTokensForTokens(
    amountIn,
    0,
    [await token1.getAddress(), await token2.getAddress()],
    signer.address,
    deadline
  );
  console.log(`Check Balance after swap token1 ${amountIn}`);
  console.log("balance of token1 ", await token1.balanceOf(signer.address));
  console.log("balance of token2 ", await token2.balanceOf(signer.address));
  return [
    await token1.balanceOf(signer.address),
    await token2.balanceOf(signer.address),
  ];
}
const token1Mint = "1000";
const token2Mint = "3000";
const token1Liquidity = "100";
const token2Liquidity = "200";
describe("swap", function () {
  it("swap", async function () {
    [signer] = await ethers.getSigners();
    //first deploy factory
    [router, factory, weth] = await deployUniswap();
    //second deploy tokens
    [token1, token2] = await deployToken(token1Mint, token2Mint);
    await createPair(signer, factory, token1, token2);
    await addLiquidity(
      signer,
      router,
      token1,
      token2,
      token1Liquidity,
      token2Liquidity
    );
    [balance1, balance2] = await swap(router, token1, token2, amountInNum);

    expect(parseFloat(ethers.formatEther(balance1))).eq(
      parseFloat(token1Mint - token1Liquidity - amountInNum)
    );
    [quoteAmountResult0, quoteAmountResult1] = await quote(
      router,
      amountInNum,
      token1,
      token2
    );
    //console.log(quoteAmountResult1);
    expect(parseFloat(ethers.formatEther(balance2))).closeTo(
      parseFloat(
        ethers.formatEther(
          ethers.parseUnits(token2Mint) -
            ethers.parseUnits(token2Liquidity) +
            quoteAmountResult1
        )
      ),
      parseFloat("1")
    );
  });
});
