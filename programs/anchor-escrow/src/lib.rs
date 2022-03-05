use anchor_lang::prelude::*;
use anchor_lang::solana_program::{clock};
use anchor_spl::token::{self, CloseAccount, Mint, SetAuthority, TokenAccount, Transfer};
use spl_token::instruction::AuthorityType;
use solana_program::borsh::try_from_slice_unchecked;
use crate::parse::{first_creator_is_verified, is_only_one_option};
use solana_account_decoder::{
    parse_account_data::{parse_account_data, AccountAdditionalData, ParsedAccount},
    UiAccountEncoding,
};


#[derive(Debug, Serialize, Clone)]
struct Holder {
    owner_wallet: String,
    associated_token_address: String,
    mint_account: String,
    metadata_account: String,
}


declare_id!("FcuGHuHkbritFfVdXC7W7kppMekwEibHuYbXy6xUCEMc");

#[program]
pub mod anchor_escrow {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>, _pool_bump: u8,
    ) -> Result<()> {
        msg!("initialize");

        let state = &mut ctx.accounts.state;
        state.amount_list = [0; SPIN_ITEM_COUNT];
        state.ratio_list = [0; SPIN_ITEM_COUNT];

        state.nonce = _pool_bump;

        Ok(())
    }

    pub fn get_nftholders(
        client: &RpcClient,
        update_authority: &Option<String>,
        creator: &Option<String>,
        position: usize,
        mint_accounts_file: &Option<String>,
        v2: bool,
        output: &String,
    ) -> Result<Vec<Holder>> {

        let creator_pubkey =
            Pubkey::from_str(&creator).expect("Failed to parse pubkey from creator!");
        let cmv2_creator = derive_cmv2_pda(&creator_pubkey);
        let accounts = get_cm_creator_accounts(client, &cmv2_creator.to_string(), position)?

        let nft_holders: Vec<Holder> = Vec::new();

        for (metadata_pubkey, account) in accounts {

            let metadata: Metadata = match try_from_slice_unchecked(&account.data) {
                Ok(metadata) => metadata,
                Err(_) => {
                    error!("Account {} has no metadata", metadata_pubkey);
                    return;
                }
            };

            // Check that first creator is verified
            if !first_creator_is_verified(&metadata.data.creators) {
                return;
            }

            let token_accounts = match retry(
                Exponential::from_millis_with_factor(250, 2.0).take(3),
                || get_holder_token_accounts(client, metadata.mint.to_string()),
            ) {
                Ok(token_accounts) => token_accounts,
                Err(_) => {
                    error!("Account {} has no token accounts", metadata_pubkey);
                    return;
                }
            };

            for (associated_token_address, account) in token_accounts {
                let data = match parse_account_data(
                    &metadata.mint,
                    &TOKEN_PROGRAM_ID,
                    &account.data,
                    Some(AccountAdditionalData {
                        spl_token_decimals: Some(0),
                    }),
                ) {
                    Ok(data) => data,
                    Err(err) => {
                        error!("Account {} has no data: {}", associated_token_address, err);
                        return;
                    }
                };

                let amount = match parse_token_amount(&data) {
                    Ok(amount) => amount,
                    Err(err) => {
                        error!(
                            "Account {} has no amount: {}",
                            associated_token_address, err
                        );
                        return;
                    }
                };

                // Only include current holder of the NFT.
                if amount == 1 {
                    let owner_wallet = match parse_owner(&data) {
                        Ok(owner_wallet) => owner_wallet,
                        Err(err) => {
                            error!("Account {} has no owner: {}", associated_token_address, err);
                            return;
                        }
                    };
                    let associated_token_address = associated_token_address.to_string();
                    let holder = Holder {
                        owner_wallet,
                        associated_token_address,
                        mint_account: metadata.mint.to_string(),
                        metadata_account: metadata_pubkey.to_string(),
                    };
                    nft_holders.push(holder);
                }
            }
        });

        Ok(nft_holders)
    }
}

pub fn get_cm_creator_accounts(
    client: &RpcClient,
    creator: &String,
    position: usize,
) -> Result<Vec<(Pubkey, Account)>> {
    if position > 4 {
        error!("CM Creator position cannot be greator than 4");
        std::process::exit(1);
    }

    let config = RpcProgramAccountsConfig {
        filters: Some(vec![RpcFilterType::Memcmp(Memcmp {
            offset: 1 + // key
            32 + // update auth
            32 + // mint
            4 + // name string length
            MAX_NAME_LENGTH + // name
            4 + // uri string length
            MAX_URI_LENGTH + // uri*
            4 + // symbol string length
            MAX_SYMBOL_LENGTH + // symbol
            2 + // seller fee basis points
            1 + // whether or not there is a creators vec
            4 + // creators
            position * // index for each creator
            (
                32 + // address
                1 + // verified
                1 // share
            ),
            bytes: MemcmpEncodedBytes::Base58(creator.to_string()),
            encoding: None,
        })]),
        account_config: RpcAccountInfoConfig {
            encoding: Some(UiAccountEncoding::Base64),
            data_slice: None,
            commitment: Some(CommitmentConfig {
                commitment: CommitmentLevel::Confirmed,
            }),
        },
        with_context: None,
    };

    let accounts = client.get_program_accounts_with_config(&TOKEN_METADATA_PROGRAM_ID, config)?;

    Ok(accounts)
}


fn get_holder_token_accounts(
    client: &RpcClient,
    mint_account: String,
) -> Result<Vec<(Pubkey, Account)>> {
    let filter1 = RpcFilterType::Memcmp(Memcmp {
        offset: 0,
        bytes: MemcmpEncodedBytes::Base58(mint_account),
        encoding: None,
    });
    let filter2 = RpcFilterType::DataSize(165);
    let account_config = RpcAccountInfoConfig {
        encoding: Some(UiAccountEncoding::Base64),
        data_slice: None,
        commitment: Some(CommitmentConfig {
            commitment: CommitmentLevel::Confirmed,
        }),
    };

    let config = RpcProgramAccountsConfig {
        filters: Some(vec![filter1, filter2]),
        account_config,
        with_context: None,
    };

    let holders = client.get_program_accounts_with_config(&TOKEN_PROGRAM_ID, config)?;

    Ok(holders)
}

fn parse_token_amount(data: &ParsedAccount) -> Result<u64> {
    let amount = data
        .parsed
        .get("info")
        .ok_or(anyhow!("Invalid data account!"))?
        .get("tokenAmount")
        .ok_or(anyhow!("Invalid token amount!"))?
        .get("amount")
        .ok_or(anyhow!("Invalid token amount!"))?
        .as_str()
        .ok_or(anyhow!("Invalid token amount!"))?
        .parse()?;
    Ok(amount)
}

fn parse_owner(data: &ParsedAccount) -> Result<String> {
    let owner = data
        .parsed
        .get("info")
        .ok_or(anyhow!("Invalid owner account!"))?
        .get("owner")
        .ok_or(anyhow!("Invalid owner account!"))?
        .as_str()
        .ok_or(anyhow!("Invalid owner amount!"))?
        .to_string();
    Ok(owner)
}
