const hre = require("hardhat");
async function deployToken(tokenOneMintAmount, tokenTwoMintAmount) {
  //   const tokenOneMintAmount = "1000";
  //   const tokenTwoMintAmount = "2000";

  //部署token1并提前mint
  const token1Contract = await hre.ethers.getContractFactory("Token1");
  const token1 = await token1Contract.deploy(
    hre.ethers.parseUnits(tokenOneMintAmount, 18)
  );
  await token1.waitForDeployment();

  //部署token2并提前mint
  const token2Contract = await hre.ethers.getContractFactory("Token2");
  const token2 = await token2Contract.deploy(
    hre.ethers.parseUnits(tokenTwoMintAmount, 18)
  );
  await token2.waitForDeployment();

  return [token1, token2];
}

module.exports = {
  deployToken,
};
