ALTER TABLE "ops"."reorgs" ADD COLUMN "acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ops"."reorgs" ADD COLUMN "acknowledgement" text;--> statement-breakpoint
-- Halts recorded before this migration were handled by hand (the indexer has been restarted since), so they must not block `run`.
UPDATE "ops"."reorgs" SET "acknowledged_at" = now(), "acknowledgement" = 'predates sticky halts (migration 0004_ops_reorg_ack)' WHERE "action" = 'halted';--> statement-breakpoint
ALTER TABLE "ops"."reorgs" ADD CONSTRAINT "reorgs_ack_check" CHECK (("ops"."reorgs"."acknowledged_at" is null and "ops"."reorgs"."acknowledgement" is null) or ("ops"."reorgs"."action" = 'halted' and "ops"."reorgs"."acknowledged_at" is not null and "ops"."reorgs"."acknowledgement" <> ''));
