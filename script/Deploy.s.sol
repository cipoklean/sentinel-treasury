// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {InvoiceRegistry} from "../src/InvoiceRegistry.sol";
import {PolicyVault} from "../src/PolicyVault.sol";

/// @notice Deploys InvoiceRegistry + PolicyVault and wires them. The sender
///         needs a registered ML-DSA-87 key and a live EVM authorisation window.
contract DeployScript is Script {
    function run() external returns (InvoiceRegistry registry, PolicyVault vault) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address agent = vm.envAddress("AGENT_ADDRESS");
        uint256 perTxCap = vm.envOr("PER_TX_CAP_WEI", uint256(5 ether));
        uint256 dailyCap = vm.envOr("DAILY_CAP_WEI", uint256(20 ether));
        uint256 mandateThreshold = vm.envOr("MANDATE_THRESHOLD_WEI", uint256(2 ether));

        vm.startBroadcast(deployerKey);
        registry = new InvoiceRegistry();
        vault = new PolicyVault(address(registry), agent, perTxCap, dailyCap, mandateThreshold);
        registry.setVault(address(vault));
        vm.stopBroadcast();

        console.log("InvoiceRegistry:", address(registry));
        console.log("PolicyVault:    ", address(vault));
    }
}
