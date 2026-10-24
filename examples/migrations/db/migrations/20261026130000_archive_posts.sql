-- ottersql:step kind=addEnumValue object="public.post_status.archived" phase=expand reversal=irreversible transaction=inside lock="none"
-- A value added in a transaction cannot be used until it commits, so it is a step of its own
ALTER TYPE "public"."post_status" ADD VALUE 'archived' AFTER 'published';
