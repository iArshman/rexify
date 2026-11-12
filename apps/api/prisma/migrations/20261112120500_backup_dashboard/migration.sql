ALTER TABLE "Setting" ADD COLUMN "backupGoogleClientId" TEXT;
ALTER TABLE "Setting" ADD COLUMN "backupGoogleClientSecret" TEXT;
ALTER TABLE "Setting" ADD COLUMN "backupGoogleRefreshToken" TEXT;
ALTER TABLE "Setting" ADD COLUMN "backupGoogleAccessToken" TEXT;
ALTER TABLE "Setting" ADD COLUMN "backupGoogleTokenExpiry" DATETIME;
ALTER TABLE "Setting" ADD COLUMN "backupGoogleEmail" TEXT;
ALTER TABLE "Setting" ADD COLUMN "backupGoogleOAuthState" TEXT;
ALTER TABLE "Setting" ADD COLUMN "backupServiceAccountJson" TEXT;
