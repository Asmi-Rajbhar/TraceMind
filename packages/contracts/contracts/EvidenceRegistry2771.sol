// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/metatx/ERC2771Context.sol";

contract EvidenceRegistry2771 is ERC2771Context {

    struct Evidence {
        bytes32 logHash;
        bytes32 reportHash;
        uint256 registeredAt;
        address registeredBy;
    }

    mapping(string => Evidence) private evidence;
    mapping(string => bool) public exists;

    event EvidenceRegistered(
        string incidentId,
        bytes32 logHash,
        bytes32 reportHash,
        address registeredBy,
        uint256 registeredAt
    );

    constructor(address trustedForwarder)
        ERC2771Context(trustedForwarder)
    {}

    function registerEvidence(
        string calldata incidentId,
        bytes32 logHash,
        bytes32 reportHash
    ) external {
        require(bytes(incidentId).length > 0, "Incident ID required");
        require(!exists[incidentId], "Evidence already registered");
        require(logHash != bytes32(0), "Log hash required");
        require(reportHash != bytes32(0), "Report hash required");

        address actualUser = _msgSender();

        evidence[incidentId] = Evidence({
            logHash: logHash,
            reportHash: reportHash,
            registeredAt: block.timestamp,
            registeredBy: actualUser
        });

        exists[incidentId] = true;

        emit EvidenceRegistered(
            incidentId,
            logHash,
            reportHash,
            actualUser,
            block.timestamp
        );
    }

    function getEvidence(string calldata incidentId)
        external
        view
        returns (
            bytes32 logHash,
            bytes32 reportHash,
            uint256 registeredAt,
            address registeredBy
        )
    {
        require(exists[incidentId], "Evidence not found");

        Evidence memory record = evidence[incidentId];

        return (
            record.logHash,
            record.reportHash,
            record.registeredAt,
            record.registeredBy
        );
    }

    function verifyEvidence(
        string calldata incidentId,
        bytes32 logHash,
        bytes32 reportHash
    ) external view returns (bool) {
        if (!exists[incidentId]) {
            return false;
        }

        Evidence storage record = evidence[incidentId];

        return (
            record.logHash == logHash &&
            record.reportHash == reportHash
        );
    }
}