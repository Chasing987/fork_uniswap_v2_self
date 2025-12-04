const hre = require("hardhat");

async function deployUniswap() {
    // deploy fatory
    const [signer] = await hre.ethers.getSigners();
    const factoryContract = await hre.ethers.getContractFactory("UniswapV2Factory");
    const fatory = await factoryContract.deploy(signer.address);
    await fatory.waitForDeployment();

    // deploy weth9
    const weth9Contract = await hre.ethers.getContractFactory("WETH9");
    const weth9 = await weth9Contract.deploy();
    await weth9.waitForDeployment();

    // deploy UniswapV2Router02
    const routerContract = await hre.ethers.getContractFactory("UniswapV2Router02");
    const router = await routerContract.deploy(await fatory.getAddress(), await weth9.getAddress());
    await router.waitForDeployment();

    console.log("factory address:", fatory.target);
    console.log("weth9 address:", weth9.target);
    console.log("router address:", router.target);
}

deployUniswap();