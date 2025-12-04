import {
  AccountAuthenticatorEd25519,
  Ed25519PublicKey,
  Ed25519Signature,
  generateSigningMessageForTransaction,
  SimpleTransaction,
  AccountAddress,
  UserTransactionResponse
} from '@aptos-labs/ts-sdk';
import { aptos, CONTRACT_ADDRESS, toHex } from './aptos';

export type CounterAction = 'increment' | 'decrement';

export interface CounterTransaction {
  action: CounterAction;
  amount: number;
}

export interface SignRawHashFunction {
  (params: { address: string; chainType: 'aptos'; hash: `0x${string}` }): Promise<{
    signature: string;
  }>;
}

/**
 * Get the contract function name for a counter action
 */
export const getCounterFunction = (action: CounterAction): `${string}::${string}::${string}` => {
  const functionName = action === 'increment' ? 'add_counter' : 'subtract_counter';
  return `${CONTRACT_ADDRESS}::counter::${functionName}` as `${string}::${string}::${string}`;
};

/**
 * Build and submit a single counter transaction with gas sponsorship
 */
export const submitCounterTransaction = async (
  action: CounterAction,
  amount: number,
  walletAddress: string,
  publicKeyHex: string,
  signRawHash: SignRawHashFunction
): Promise<string> => {
  try {
    // Build the transaction with feePayer enabled (for sponsored transactions)
    const rawTxn = await aptos.transaction.build.simple({
      sender: walletAddress,
      withFeePayer: true,
      data: {
        function: getCounterFunction(action),
        typeArguments: [],
        functionArguments: [amount],
      },
    });

    // Generate signing message
    const message = generateSigningMessageForTransaction(rawTxn);

    // Sign with Privy wallet
    const { signature: rawSignature } = await signRawHash({
      address: walletAddress,
      chainType: 'aptos',
      hash: `0x${toHex(message)}`,
    });

    // Create authenticator
    // Ensure publicKeyHex is properly formatted (remove 0x prefix and any leading bytes)
    let cleanPublicKey = publicKeyHex.startsWith('0x') ? publicKeyHex.slice(2) : publicKeyHex;

    // If public key is 66 characters (33 bytes), remove the first byte (00 prefix)
    if (cleanPublicKey.length === 66) {
      cleanPublicKey = cleanPublicKey.slice(2);
    }

    const senderAuthenticator = new AccountAuthenticatorEd25519(
      new Ed25519PublicKey(cleanPublicKey),
      new Ed25519Signature(rawSignature.startsWith('0x') ? rawSignature.slice(2) : rawSignature)
    );

    // Create SimpleTransaction object for serialization
    // For feePayer transactions, we pass undefined as feePayerAddress since it will be added by the backend
    const simpleTransaction = new SimpleTransaction(rawTxn.rawTransaction);

    // Serialize transaction and signature for backend sponsorship
    const serializedTransaction = simpleTransaction.bcsToHex().toString();
    const serializedSignature = senderAuthenticator.bcsToHex().toString();

    // Send to backend for gas sponsorship
    const response = await fetch('/api/sponsor-transaction', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        serializedTransaction,
        senderSignature: serializedSignature,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.details || 'Failed to sponsor transaction');
    }

    const result = await response.json();

    // Wait for confirmation
    const executed = await aptos.waitForTransaction({
      transactionHash: result.transactionHash,
    });

    if (!executed.success) {
      throw new Error('Transaction failed');
    }

    return result.transactionHash;
  } catch (error) {
    console.error(`Error submitting ${action} transaction:`, error);
    throw error;
  }
};

/**
 * Build, sign, and sponsor a transaction with native wallet
 * Returns the transaction hash after submission (before confirmation)
 */
const buildSignAndSponsorTransaction = async (
  action: CounterAction,
  amount: number,
  walletAddress: string,
  signTransaction: any
): Promise<string> => {
  // Step 1: Build feePayer transaction with 5 minute expiration
  const simpleTx = await aptos.transaction.build.simple({
    sender: AccountAddress.from(walletAddress),
    withFeePayer: true,
    data: {
      function: getCounterFunction(action),
      functionArguments: [amount],
    },
    options: {
      expireTimestamp: Math.floor(Date.now() / 1000) + (5 * 60),
    },
  });

  console.log('Native wallet - Transaction built, requesting signature');

  // Step 2: Sign the transaction with native wallet
  const senderSig = await signTransaction({ transactionOrPayload: simpleTx });

  console.log('Native wallet - Transaction signed, sending for sponsorship');

  // Step 3: Send to backend for Shinami gas sponsorship and submission
  const response = await fetch('/api/sponsor-transaction', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      serializedTransaction: simpleTx.bcsToHex().toString(),
      senderSignature: senderSig.authenticator.bcsToHex().toString(),
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.details || 'Failed to sponsor transaction');
  }

  const result = await response.json();
  console.log('Native wallet - Transaction sponsored and submitted:', result.transactionHash);

  return result.transactionHash;
};

/**
 * Submit counter transaction with native wallet using Shinami gas sponsorship
 * Flow: FE builds transaction -> FE signs with wallet -> BE sponsors and submits -> Wait for confirmation
 * Returns transaction hash only after on-chain confirmation
 */
export const submitCounterTransactionNative = async (
  action: CounterAction,
  amount: number,
  walletAddress: string,
  signTransaction: any
): Promise<string> => {
  try {
    if (!walletAddress) {
      throw new Error('No wallet address provided');
    }

    // Step 1: Build, sign, and submit transaction for sponsorship
    const transactionHash = await buildSignAndSponsorTransaction(action, amount, walletAddress, signTransaction);

    if (!transactionHash) {
      throw new Error('Unable to get transaction hash from backend');
    }

    console.log('Native wallet - Waiting for transaction confirmation:', transactionHash);

    // Step 2: Wait for transaction to be confirmed on-chain
    const executedTransaction = await aptos.waitForTransaction({
      transactionHash,
    }) as UserTransactionResponse;

    console.log('Native wallet - Transaction confirmed:', executedTransaction);

    // Step 3: Verify transaction success
    if (!executedTransaction.success) {
      throw new Error('Transaction failed on-chain');
    }

    // Return the transaction hash only after successful confirmation
    return transactionHash;
  } catch (error) {
    console.error(`Error submitting ${action} transaction with native wallet:`, error);
    throw error;
  }
};

/**
 * Fetch current counter value from blockchain
 */
export const fetchCounterValue = async (address: string): Promise<number | null> => {
  try {
    const result = await aptos.view({
      payload: {
        function: `${CONTRACT_ADDRESS}::counter::get_counter`,
        typeArguments: [],
        functionArguments: [address],
      },
    });

    return Number(result[0]);
  } catch (error) {
    console.error('Error fetching counter value:', error);
    return null;
  }
};
