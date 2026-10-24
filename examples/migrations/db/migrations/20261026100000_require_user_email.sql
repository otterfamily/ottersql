-- ottersql:step kind=addCheck object="public.users.ottersql_not_null_email" phase=contract reversal=reversible transaction=inside lock="access exclusive"
-- Holds for new rows at once, without scanning the table
ALTER TABLE "public"."users" ADD CONSTRAINT "ottersql_not_null_email" CHECK ("email" IS NOT NULL) NOT VALID;

-- ottersql:step kind=validateCheck object="public.users.ottersql_not_null_email" phase=contract reversal=reversible transaction=inside lock="share update exclusive"
-- Checking existing rows takes a lock that lets reads and writes go on; existing nulls must be filled first
ALTER TABLE "public"."users" VALIDATE CONSTRAINT "ottersql_not_null_email";

-- ottersql:step kind=setNotNull object="public.users.email" phase=contract reversal=reversible transaction=inside lock="access exclusive"
-- The validated check spares Postgres the scan
ALTER TABLE "public"."users" ALTER COLUMN "email" SET NOT NULL;
ALTER TABLE "public"."users" DROP CONSTRAINT "ottersql_not_null_email";
