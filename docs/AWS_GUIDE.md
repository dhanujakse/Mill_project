# Mill Mate on AWS (EC2 + S3)

The web app stays on Vercel. The **API** runs on one EC2 server, and **files and backups** live in S3.

```
Phones / Vercel site  --HTTPS-->  Caddy (EC2)  -->  Node API  --> SQLite file on the server disk
                                                        |
                                                        +--> S3 bucket: uploads/  (attachments, LR, proof of receipt)
                                                                        backups/  (nightly database copy)
```

What was built for this (already in the repo):
- **S3 attachments**: the API uploads files to S3 and stores only a short reference in the database. Without `S3_BUCKET` set it works exactly as before (files inline), so local development needs no AWS.
- **Nightly backup** of the database to S3 (`server/scripts/backup-to-s3.mjs` + a systemd timer).
- **Setup and update scripts** for the server (`deploy/ec2/`), and the IAM/S3 policy files (`deploy/aws/`).
- **No AWS keys anywhere.** The server gets its permissions from an IAM role attached to the EC2 instance.

> **Honest status:** the S3 code was tested end to end (upload, download, validation, backup and restore, and the full browser flow) against an S3 emulator. The EC2 scripts were syntax-checked and reviewed but **could not be run on Linux from the machine they were written on**. Their first run on a brand-new instance is the real test, so do steps 4 to 6 on a fresh instance (you can throw it away and start again if something fails).

## Rough monthly cost (Mumbai, check the AWS pricing calculator for exact numbers)
| Item | About |
|---|---|
| EC2 `t3.micro` (1 GB RAM, plenty for this app; free for 12 months on new accounts) | 8 to 9 USD |
| Public IPv4 address (AWS now charges for it) | 3.6 USD |
| 20 GB disk (gp3) | 2 USD |
| S3 storage and requests | under 1 USD to start |
| **Total** | **roughly 12 to 15 USD** (about 4 USD while the free tier applies) |

---

## 0. AWS account basics (one time)
1. Create the account at aws.amazon.com and **turn on MFA for the root user**.
2. Create an IAM user (or Identity Center user) with admin rights for yourself, and use that instead of root.
3. Install the **AWS CLI v2**, then run `aws configure` (region `ap-south-1`).
4. **Billing > Budgets**: create a monthly budget of about 20 USD with an email alert.

Below, replace `YOUR-BUCKET-NAME` with a globally unique name such as `millmate-files-8f3k2`.

## 1. S3 bucket
Run from the repo folder:

```powershell
aws s3api create-bucket --bucket YOUR-BUCKET-NAME --region ap-south-1 --create-bucket-configuration LocationConstraint=ap-south-1
aws s3api put-public-access-block --bucket YOUR-BUCKET-NAME --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket YOUR-BUCKET-NAME --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket YOUR-BUCKET-NAME --server-side-encryption-configuration file://deploy/aws/s3-encryption.json
aws s3api put-bucket-lifecycle-configuration --bucket YOUR-BUCKET-NAME --lifecycle-configuration file://deploy/aws/s3-lifecycle.json
```
This makes the bucket private, encrypted and versioned (an overwritten or deleted attachment can be recovered), and deletes database backups after 60 days.

## 2. Permission for the server (IAM role)
1. Edit `deploy/aws/iam-ec2-policy.json` and replace both `YOUR-BUCKET-NAME`. The server may only read/write under `uploads/` and write under `backups/`. It cannot delete anything or read the backups.
2. Run (replace `ACCOUNT_ID` with your 12-digit AWS account number):

```powershell
aws iam create-policy --policy-name MillMateS3Access --policy-document file://deploy/aws/iam-ec2-policy.json
aws iam create-role --role-name MillMateEC2Role --assume-role-policy-document file://deploy/aws/ec2-trust-policy.json
aws iam attach-role-policy --role-name MillMateEC2Role --policy-arn arn:aws:iam::ACCOUNT_ID:policy/MillMateS3Access
aws iam create-instance-profile --instance-profile-name MillMateEC2Profile
aws iam add-role-to-instance-profile --instance-profile-name MillMateEC2Profile --role-name MillMateEC2Role
```

## 3. Launch the EC2 server (Console: EC2 > Launch instance)
| Setting | Value |
|---|---|
| Name | `millmate-api` |
| Image | **Ubuntu Server 24.04 LTS** |
| Type | `t3.micro` (use `t3.small` if you expect heavy use) |
| Key pair | create one, download the `.pem` and keep it safe |
| Network / security group | allow **SSH (22) from My IP only**, **HTTP (80)** and **HTTPS (443)** from anywhere |
| Storage | **20 GiB gp3** |
| Advanced details > IAM instance profile | `MillMateEC2Profile` |
| Advanced details > Metadata version | **V2 only (required)** |

Then **EC2 > Elastic IPs > Allocate**, and **associate it with the instance**. Without this the public address changes whenever the server is stopped.

## 4. Point a hostname at the server
The apps need **HTTPS**, and the free certificate needs a hostname.
- **Best:** a domain you own. Add an **A record** `api.yourdomain.com` pointing to the Elastic IP.
- **No domain yet:** use `13-233-10-20.sslip.io` (your Elastic IP with dashes instead of dots). It resolves to that IP and works with the certificate, but it depends on a free third-party service. Fine to start, get a real domain before you rely on it.

The API address you choose here ends up inside the Android/iOS apps, so pick the final one before publishing.

## 5. Install the API
Connect (`ssh -i your-key.pem ubuntu@ELASTIC_IP`), then:

```bash
git clone https://github.com/ramya25-star/Mill_project.git
sudo -E DOMAIN=api.yourdomain.com S3_BUCKET=YOUR-BUCKET-NAME SEED_PASSWORD='pick-a-strong-password' \
     bash Mill_project/deploy/ec2/setup.sh
```
It installs Node 22 and Caddy, creates the service, writes the settings, and starts everything. If you leave out `SEED_PASSWORD`, it generates a strong one and prints it once. The private repository case: use a GitHub token in the clone URL.

The settings live in `/etc/millmate.env` (JWT secret, database path, S3 bucket, CORS list, WhatsApp keys). Edit it with `sudo nano /etc/millmate.env`, then `sudo systemctl restart millmate`. Running the setup script again never overwrites it.

## 6. Check everything works
| Check | How | Expected |
|---|---|---|
| API and HTTPS | open `https://api.yourdomain.com/api/health` | `{"ok":true}` |
| Storage mode | `sudo journalctl -u millmate -n 20 --no-pager` | `File storage: S3 bucket "YOUR-BUCKET-NAME"` and `Database file: /var/lib/millmate/alagiri.db` |
| Login | log in to the web app with `admin` and your password | works |
| Attachments | upload an LR copy in an order | a new file appears in S3 under `uploads/`, and "View LR" opens it |
| Backup | `sudo systemctl start millmate-backup.service` then `aws s3 ls s3://YOUR-BUCKET-NAME/backups/` (from your PC) | a `.db.gz` file |
| Survives restart | `sudo reboot`, wait a minute, open the health URL | works again, data still there |

## 7. Switch the apps to the new server
1. **Web (Vercel):** in `.env.production` set `VITE_API_BASE_URL=https://api.yourdomain.com/api`, commit and push. Also confirm `CORS_ORIGIN` in `/etc/millmate.env` contains your Vercel URL.
2. **Android:** the API address is built into the app, so **rebuild the bundle after this change**: raise `versionCode` in `android/app/build.gradle`, then `npm run android:aab` (see `RELEASE_GUIDE.md`).
3. **iOS:** `npm run ios:sync` on the Mac, then archive again.
4. When all of it works, **suspend or delete the Render service** so you stop paying for it.

## 8. Day-to-day operations
| Task | Command (on the server) |
|---|---|
| Deploy the latest code | `sudo bash /opt/millmate/deploy/ec2/update.sh` (about 20 seconds of downtime, and it checks the API came back) |
| Watch the API log | `sudo journalctl -u millmate -f` |
| Restart | `sudo systemctl restart millmate` |
| Backup timer status | `systemctl list-timers millmate-backup.timer` |

### Restoring a backup
The server can write backups but deliberately cannot read them, so a stolen server key can't read your history. Restore from your own PC:
```powershell
aws s3 ls s3://YOUR-BUCKET-NAME/backups/
aws s3 cp s3://YOUR-BUCKET-NAME/backups/alagiri-YYYYMMDD-HHMMSS.db.gz .
scp -i your-key.pem alagiri-YYYYMMDD-HHMMSS.db.gz ubuntu@ELASTIC_IP:/tmp/
```
On the server:
```bash
sudo systemctl stop millmate
sudo gunzip -c /tmp/alagiri-YYYYMMDD-HHMMSS.db.gz | sudo -u millmate tee /var/lib/millmate/alagiri.db > /dev/null
sudo rm -f /var/lib/millmate/alagiri.db-wal /var/lib/millmate/alagiri.db-shm
sudo systemctl start millmate
```

## 9. Security notes
- Keep SSH restricted to your own IP. If your IP changes, edit the security group.
- The server is set to install security updates automatically (`unattended-upgrades`).
- Anyone who can log into the AWS console can reach the data: keep MFA on for every AWS user.
- The `JWT_SECRET` in `/etc/millmate.env` must never change or be shared.
- Optional but wise: a CloudWatch alarm on the instance status check, and an EBS snapshot schedule.

## 10. Limits to know about
- **One server, one database file.** If the instance is down, the app is down (typically minutes). SQLite is fine for a company this size; moving to a managed database is possible later if you outgrow it.
- Attachments over **10 MB** are refused (the app tells the user).
- Existing attachments stored inline in the database keep working. Only new uploads go to S3 (production has no orders yet, so there is nothing to migrate).
