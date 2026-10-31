// Verifies the user's signed request and forwards it
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";

contract TraceMindForwarder is ERC2771Forwarder {
    constructor() ERC2771Forwarder("TraceMindForwarder") {}
}