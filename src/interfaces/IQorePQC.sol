// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @notice QoreChain post-quantum precompiles. PQC_VERIFY and PQC_STATUS are
///         active on the qorechain-diana testnet only; on mainnet the addresses
///         return empty data. Always check return-data length on raw calls.
interface IQorePQC {
    /// @notice Verify an ML-DSA-87 (Dilithium-5, FIPS 204) signature.
    /// @param pubkey The 2592-byte ML-DSA-87 public key.
    /// @param signature The 4627-byte ML-DSA-87 signature.
    /// @param message The raw message bytes that were signed.
    /// @return valid True if the signature is valid.
    function pqcVerify(
        bytes calldata pubkey,
        bytes calldata signature,
        bytes calldata message
    ) external view returns (bool valid);

    /// @notice Check whether an account has a registered ML-DSA-87 key.
    /// @return registered A PQC key is bound to the account.
    /// @return algorithmId Algorithm id (1 = ML-DSA-87).
    /// @return pubkey The registered public key (empty if none).
    /// @return possessionProven The key was registered with a verified proof of possession.
    function pqcKeyStatus(address account)
        external
        view
        returns (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven);
}
