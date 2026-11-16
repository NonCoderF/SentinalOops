# Email worker

The active Kafka email consumer is `apps/alert-manager/backend/src/worker.ts` with group `sentinelops-email-workers`. It reuses the existing Nodemailer templates and bounded retry/dead-letter behavior.
