CREATE SCHEMA "chain";
--> statement-breakpoint
CREATE SCHEMA "ops";
--> statement-breakpoint
CREATE TABLE "chain"."blocks" (
	"chain_id" integer NOT NULL,
	"number" bigint NOT NULL,
	"hash" text NOT NULL,
	"parent_hash" text NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	CONSTRAINT "blocks_chain_id_number_pk" PRIMARY KEY("chain_id","number"),
	CONSTRAINT "blocks_hash_key" UNIQUE("chain_id","hash")
);
--> statement-breakpoint
CREATE TABLE "chain"."erc20_transfers" (
	"chain_id" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"tx_hash" text NOT NULL,
	"token" text NOT NULL,
	"from_address" text NOT NULL,
	"to_address" text NOT NULL,
	"value" numeric(78, 0) NOT NULL,
	CONSTRAINT "erc20_transfers_chain_id_block_hash_log_index_pk" PRIMARY KEY("chain_id","block_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "chain"."logs" (
	"chain_id" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"tx_hash" text NOT NULL,
	"tx_index" integer NOT NULL,
	"address" text NOT NULL,
	"topics" text[] NOT NULL,
	"data" text NOT NULL,
	CONSTRAINT "logs_chain_id_block_hash_log_index_pk" PRIMARY KEY("chain_id","block_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "ops"."ranges" (
	"chain_id" integer NOT NULL,
	"from_block" bigint NOT NULL,
	"to_block" bigint NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"block_count" integer NOT NULL,
	"log_count" integer NOT NULL,
	"transfer_count" integer NOT NULL,
	"swap_count" integer NOT NULL,
	"reject_count" integer NOT NULL,
	"payload_sha256" text NOT NULL,
	"run_id" text NOT NULL,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ranges_chain_id_from_block_pk" PRIMARY KEY("chain_id","from_block"),
	CONSTRAINT "ranges_bounds_check" CHECK ("ops"."ranges"."to_block" >= "ops"."ranges"."from_block"),
	CONSTRAINT "ranges_status_check" CHECK ("ops"."ranges"."status" in ('candidate', 'published', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "ops"."runs" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"failure_reason" text,
	"first_block" bigint,
	"last_block" bigint,
	"rpc_calls" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "runs_status_check" CHECK ("ops"."runs"."status" in ('running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "chain"."uniswap_v3_swaps" (
	"chain_id" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"tx_hash" text NOT NULL,
	"pool" text NOT NULL,
	"sender" text NOT NULL,
	"recipient" text NOT NULL,
	"amount0" numeric(78, 0) NOT NULL,
	"amount1" numeric(78, 0) NOT NULL,
	"sqrt_price_x96" numeric(78, 0) NOT NULL,
	"liquidity" numeric(78, 0) NOT NULL,
	"tick" integer NOT NULL,
	CONSTRAINT "uniswap_v3_swaps_chain_id_block_hash_log_index_pk" PRIMARY KEY("chain_id","block_hash","log_index")
);
--> statement-breakpoint
ALTER TABLE "ops"."ranges" ADD CONSTRAINT "ranges_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "ops"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "erc20_transfers_block_idx" ON "chain"."erc20_transfers" USING btree ("chain_id","block_number");--> statement-breakpoint
CREATE INDEX "logs_block_idx" ON "chain"."logs" USING btree ("chain_id","block_number");--> statement-breakpoint
CREATE INDEX "uniswap_v3_swaps_block_idx" ON "chain"."uniswap_v3_swaps" USING btree ("chain_id","block_number");