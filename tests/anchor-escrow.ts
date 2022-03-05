import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import NodeWallet from '@project-serum/anchor/dist/cjs/nodewallet';
import { AnchorEscrow } from '../target/types/anchor_escrow';
import { PublicKey, SystemProgram, Transaction, Connection, Commitment, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, Token } from "@solana/spl-token";
import { assert } from "chai";

describe('anchor-escrow', () => {
  // const commitment: Commitment = 'processed';
  // const connection = new Connection('https://rpc-mainnet-fork.dappio.xyz', { commitment, wsEndpoint: 'wss://rpc-mainnet-fork.dappio.xyz/ws' });
  // const options = anchor.Provider.defaultOptions();
  // const wallet = NodeWallet.local();
  // const provider = new anchor.Provider(connection, wallet, options);
  const provider = anchor.Provider.env();

  anchor.setProvider(provider);

  const program = anchor.workspace.AnchorEscrow as Program<AnchorEscrow>;

  let mintA = null as Token;
  let mintB = null as Token;
  let initializerTokenAccountA = null;
  let initializerTokenAccountB = null;
  let takerTokenAccountA = null;
  let takerTokenAccountB = null;
  let vault_account_pda = null;
  let vault_account_bump = null;
  let vault_authority_pda = null;

  let pool_account_pda = null;
  let pool_account_bump = null;

  let token_vault_list = [];

  const takerAmount = 1000;
  const initializerAmount = 500;

  const escrowAccount = anchor.web3.Keypair.generate();
  const payer = anchor.web3.Keypair.generate();
  const mintAuthority = anchor.web3.Keypair.generate();
  const initializerMainAccount = anchor.web3.Keypair.generate();
  const takerMainAccount = anchor.web3.Keypair.generate();

  it("Initialize program state", async () => {
    // Airdropping tokens to a payer.
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(payer.publicKey, 1000000000),
      "processed"
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(provider.wallet.publicKey, 1000000000),
      "processed"
    );

    // Fund Main Accounts
    await provider.send(
      (() => {
        const tx = new Transaction();
        tx.add(
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: initializerMainAccount.publicKey,
            lamports: 100000000,
          }),
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: takerMainAccount.publicKey,
            lamports: 100000000,
          })
        );
        return tx;
      })(),
      [payer]
    );

    mintA = await Token.createMint(
      provider.connection,
      payer,
      mintAuthority.publicKey,
      null,
      0,
      TOKEN_PROGRAM_ID
    );

    mintB = await Token.createMint(
      provider.connection,
      payer,
      mintAuthority.publicKey,
      null,
      0,
      TOKEN_PROGRAM_ID
    );

    initializerTokenAccountA = await mintA.createAccount(initializerMainAccount.publicKey);
    takerTokenAccountA = await mintA.createAccount(takerMainAccount.publicKey);

    initializerTokenAccountB = await mintB.createAccount(initializerMainAccount.publicKey);
    takerTokenAccountB = await mintB.createAccount(takerMainAccount.publicKey);

    await mintA.mintTo(
      initializerTokenAccountA,
      mintAuthority.publicKey,
      [mintAuthority],
      initializerAmount
    );

    await mintB.mintTo(
      takerTokenAccountB,
      mintAuthority.publicKey,
      [mintAuthority],
      takerAmount
    );

    let _initializerTokenAccountA = await mintA.getAccountInfo(initializerTokenAccountA);
    let _takerTokenAccountB = await mintB.getAccountInfo(takerTokenAccountB);

    assert.ok(_initializerTokenAccountA.amount.toNumber() == initializerAmount);
    assert.ok(_takerTokenAccountB.amount.toNumber() == takerAmount);
  });

  it("Initialize escrow", async () => {
    let [_pool, _pool_bump] = await PublicKey.findProgramAddress([Buffer.from(anchor.utils.bytes.utf8.encode("sw_game_seeds"))], program.programId);
    pool_account_pda = _pool;
    pool_account_bump = _pool_bump;

    const [_vault_account_pda, _vault_account_bump] = await PublicKey.findProgramAddress(
      [Buffer.from(anchor.utils.bytes.utf8.encode("sw_token-seed"))],
      program.programId
    );
    vault_account_pda = _vault_account_pda;
    vault_account_bump = _vault_account_bump;

    const [_vault_authority_pda, _vault_authority_bump] = await PublicKey.findProgramAddress(
      [Buffer.from(anchor.utils.bytes.utf8.encode("escrow"))],
      program.programId
    );
    vault_authority_pda = _vault_authority_pda;

    console.log('initialize start...');

    await program.rpc.initialize(
      _pool_bump,
      {
        accounts: {
          initializer: initializerMainAccount.publicKey,
          state: pool_account_pda,
          systemProgram: anchor.web3.SystemProgram.programId,
        },
        signers: [initializerMainAccount]
      }
    );

    console.log('initialize end...');
  });

  it("Set Item", async () => {
    console.log('Start to Set Item...');

    for (let i = 0; i < 15; i++) {
      let randomPubkey = anchor.web3.Keypair.generate().publicKey;
      let [_token_vault, _token_vault_bump] = await PublicKey.findProgramAddress([Buffer.from(randomPubkey.toBuffer())], program.programId);

      token_vault_list.push({vault: _token_vault, bump: _token_vault_bump});

      let ratio = i == 14 ? 30 : 5;
      await program.rpc.setItem(
        _token_vault_bump,
        i,
        ratio,
        new anchor.BN(2),
        {
          accounts: {
            owner: initializerMainAccount.publicKey,
            state: pool_account_pda,
            tokenMint: mintA.publicKey,
            tokenVault: _token_vault,
            rand: randomPubkey,
            rewardAccount: initializerTokenAccountA,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY
          },
          signers: [initializerMainAccount]
        }
      );
    }

    console.log('End to Set Item...');
  });


  it("spin_wheel", async () => {
    console.log('Start to spin_wheel...');
    await program.rpc.spinWheel({
      accounts: {
        state: pool_account_pda,
      }
    });

    let _state = await program.account.spinItemList.fetch(
      pool_account_pda
    );

    let t_vault_account = token_vault_list[_state.lastSpinindex];
    console.log('spin token vault : ', t_vault_account);

    console.log('last spin index : ', _state.lastSpinindex);
    await program.rpc.transferRewards(
      _state.lastSpinindex,
      {
        accounts: {
          owner: initializerMainAccount.publicKey,
          state: pool_account_pda,
          tokenMint: mintA.publicKey,
          tokenVault: t_vault_account.vault,
          destAccount: initializerTokenAccountA,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [initializerMainAccount]
      });

    console.log('End to spin_wheel...');
  });

});
