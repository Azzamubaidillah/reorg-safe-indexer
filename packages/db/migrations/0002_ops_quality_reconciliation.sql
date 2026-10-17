CREATE TABLE "ops"."backfill_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"from_block" bigint NOT NULL,
	"to_block" bigint NOT NULL,
	"status" text NOT NULL,
	"failure_reason" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "backfill_jobs_range_key" UNIQUE("chain_id","from_block","to_block"),
	CONSTRAINT "backfill_jobs_status_check" CHECK ("ops"."backfill_jobs"."status" in ('queued', 'running', 'resolved')),
	CONSTRAINT "backfill_jobs_attempts_check" CHECK ("ops"."backfill_jobs"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ops"."lag_samples" (
	"chain_id" integer NOT NULL,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"head_block" bigint NOT NULL,
	"finalized_block" bigint NOT NULL,
	"stored_tip" bigint,
	CONSTRAINT "lag_samples_chain_id_sampled_at_pk" PRIMARY KEY("chain_id","sampled_at")
);
--> statement-breakpoint
CREATE TABLE "ops"."quality_results" (
	"chain_id" integer NOT NULL,
	"from_block" bigint NOT NULL,
	"gate" text NOT NULL,
	"passed" boolean NOT NULL,
	"rows_checked" integer NOT NULL,
	"rows_failed" integer NOT NULL,
	"detail" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quality_results_chain_id_from_block_gate_pk" PRIMARY KEY("chain_id","from_block","gate")
);
--> statement-breakpoint
CREATE TABLE "ops"."reconciliations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ops"."reconciliations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"chain_id" integer NOT NULL,
	"from_block" bigint NOT NULL,
	"to_block" bigint NOT NULL,
	"provider" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"blocks_checked" integer NOT NULL,
	"hash_mismatches" jsonb NOT NULL,
	"stored_log_count" integer NOT NULL,
	"observed_log_count" integer NOT NULL,
	"explanation" text,
	CONSTRAINT "reconciliations_status_check" CHECK ("ops"."reconciliations"."status" in ('match', 'mismatch'))
);
--> statement-breakpoint
ALTER TABLE "ops"."ranges" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "backfill_jobs_open_idx" ON "ops"."backfill_jobs" USING btree ("chain_id","status","created_at");--> statement-breakpoint
CREATE INDEX "reconciliations_range_idx" ON "ops"."reconciliations" USING btree ("chain_id","from_block");