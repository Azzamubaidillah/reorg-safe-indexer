CREATE TABLE "ops"."reorgs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ops"."reorgs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"chain_id" integer NOT NULL,
	"run_id" text NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text NOT NULL,
	"ancestor_block" bigint,
	"fork_block" bigint NOT NULL,
	"depth" integer NOT NULL,
	"rollback_from" bigint,
	"finalized_block" bigint NOT NULL,
	"orphaned" jsonb NOT NULL,
	"canonical" jsonb NOT NULL,
	CONSTRAINT "reorgs_action_check" CHECK ("ops"."reorgs"."action" in ('rolled_back', 'halted')),
	CONSTRAINT "reorgs_shape_check" CHECK (("ops"."reorgs"."action" = 'rolled_back' and "ops"."reorgs"."ancestor_block" is not null and "ops"."reorgs"."rollback_from" is not null) or ("ops"."reorgs"."action" = 'halted' and "ops"."reorgs"."ancestor_block" is null and "ops"."reorgs"."rollback_from" is null))
);
--> statement-breakpoint
ALTER TABLE "ops"."reorgs" ADD CONSTRAINT "reorgs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "ops"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reorgs_chain_detected_idx" ON "ops"."reorgs" USING btree ("chain_id","detected_at");