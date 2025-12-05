const { ethers } = require("hardhat");
const { addLiquidity } = require("./addLiquidity_test");
const { createPair } = require("./addLiquidity_test");
const { deployUniswap } = require("./utils/deployFactory");
const { deployToken } = require("./utils/deployToken");
const { expect } = require("chai");
async function quote(router, quoteAmount0, token1, token2) {
  //调用amountOut询价
  const quoteResult = await router.getAmountsOut(
    ethers.parseUnits(quoteAmount0, 18),
    [await token1.getAddress(), await token2.getAddress()]
  );
  console.log(
    "Quote executed successfully, tokenInAmount=%s,tokenOutAmount=%s",
    quoteResult[0],
    quoteResult[1]
  );
  return [quoteResult[0], quoteResult[1]];
}

const quoteAmount0 = "5";
const token1Mint = "1000";
const token2Mint = "3000";
const token1Liquidity = "100";
const token2Liquidity = "200";
describe("Test Quote", function () {
  it("test quote after add liquidity", async function () {
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
    [quoteAmountResult0, quoteAmountResult1] = await quote(
      router,
      quoteAmount0,
      token1,
      token2
    );
    expect(quoteAmountResult0).to.eq(ethers.parseUnits(quoteAmount0));
    expect(parseFloat(ethers.formatEther(quoteAmountResult1))).to.closeTo(
      parseFloat("10"),
      parseFloat("0.6")
    );
  });
});

module.exports = {
  quote,
};

//quote fumular
// uint amountInWithFee = amountIn.mul(997);
// uint numerator = amountInWithFee.mul(reserveOut);
// uint denominator = reserveIn.mul(1000).add(amountInWithFee);
// amountOut = numerator / denominator;
