.PHONY: build test test-unit test-fork gas fmt check deploy-dry deploy-aevum
export PATH := $(HOME)/.foundry/bin:$(PATH)

build:
	forge build

# everything, including fork tests against the real tUSD8 (needs https://rpc-test.qday.info)
test:
	forge test

# no network
test-unit:
	forge test --no-match-path "test/fork/*"

test-fork:
	forge test --match-path "test/fork/*" -vv

gas:
	forge test --gas-report

fmt:
	forge fmt

check: build test gas

# Aevum is Shanghai + legacy transactions. Needs DEPLOYER_PRIVATE_KEY in .env (testnet-only key).
deploy-dry:
	set -a; . ./.env; set +a; forge script script/Deploy.s.sol --rpc-url aevum --legacy

deploy-aevum:
	set -a; . ./.env; set +a; forge script script/Deploy.s.sol --rpc-url aevum --legacy --broadcast
