# Deploy with Docker Compose

Mintless runs as one container. The container keeps all data in SQLite under `/data`, which you mount from a host directory. The encryption key for provider access tokens comes from a separate secret file.

## Prepare the host

1. Create a data directory and a secrets directory outside any backup set that also contains the key:

   ```sh
   mkdir -p data secrets
   openssl rand -base64 32 > secrets/master.key
   chmod 600 secrets/master.key
   ```

2. Make the data directory writable by the container user. The image runs as `node` (UID 1000):

   ```sh
   sudo chown 1000:1000 data
   chmod 700 data
   ```

3. Copy `deploy/compose.yaml` next to these directories, or set `MINTLESS_DATA` and `MINTLESS_MASTER_KEY_PATH` to their paths.

## Start the service

1. Build the image, or set `MINTLESS_IMAGE` to a published image:

   ```sh
   docker compose -f deploy/compose.yaml build
   ```

2. Start it:

   ```sh
   docker compose -f deploy/compose.yaml up -d
   ```

3. Create the first administrator. Mintless has no public registration:

   ```sh
   docker compose -f deploy/compose.yaml exec mintless node src/server/cli.ts user:create --username admin --role admin
   ```

   The command prints a generated password. To choose one, pass `-e MINTLESS_NEW_PASSWORD=...` to `exec`.

4. Open `http://127.0.0.1:3000` and sign in. The port binds to `127.0.0.1` by default. Set `MINTLESS_BIND` and `MINTLESS_PUBLISH_PORT` to change it.

Put HTTPS in front of the service with a reverse proxy or a tunnel. Session cookies are marked `Secure` when the request arrives over HTTPS or with `X-Forwarded-Proto: https`.

To try the app without bank credentials, add demo connections from **Settings**, or run `node src/server/cli.ts demo:seed --member <username>` inside the container.

## Recover an admin password

Administrator passwords are changed only on the server, never in the browser, so a forgotten password cannot lock you out. The command asks for the new password twice without echoing it, then signs that user out everywhere. Roles, account sharing, and notes are not touched.

```sh
docker compose -f deploy/compose.yaml exec mintless node src/server/cli.ts user:password --username admin
```

To supply the password from a secret manager or script instead, pipe one line to standard input and disable the TTY with `-T`:

```sh
printf '%s\n' "$NEW_PASSWORD" | docker compose -f deploy/compose.yaml exec -T mintless node src/server/cli.ts user:password --username admin --password-stdin
```

The command works for members too. It fails without changing anything when the user does not exist, the two entries differ, or the password is shorter than 10 characters. Without Docker, run `node src/server/cli.ts user:password --username admin` with the same environment as the server.

The browser cannot create administrators or change their passwords. To add an admin, run `user:create --role admin` on the server, or set a member's password with `user:password` and then promote them in **Settings**.

## Back up the database

A copy of the live `mintless.sqlite` file is not a safe backup in WAL mode. Write a consistent snapshot instead:

```sh
docker compose -f deploy/compose.yaml exec mintless node src/server/cli.ts backup --out /data/backup-$(date +%F).sqlite
```

Move snapshots off the host with encryption, for example with restic or age. Store `master.key` separately: a snapshot without the key cannot decrypt provider access tokens, and the key without a snapshot has nothing to decrypt.

## Upgrade

Pull or rebuild the image, then run `docker compose up -d`. Mintless applies pending SQL migrations from `db/migrations` at startup. Take a snapshot before you upgrade.

## Configuration reference

| Variable | Default | Meaning |
| --- | --- | --- |
| `MINTLESS_DATA_DIR` | `/data` in the image | Directory for `mintless.sqlite` |
| `MINTLESS_MASTER_KEY_FILE` | required | File with a base64 key of 32 bytes. `MINTLESS_MASTER_KEY` accepts the value directly instead |
| `MINTLESS_HOST`, `MINTLESS_PORT` | `0.0.0.0`, `3000` in the image | Listen address. Startup fails if the port is in use |
| `SYNC_INTERVAL_HOURS` | `12` | Minimum time between scheduled syncs of an Item. `0` disables the scheduler |
| `MINTLESS_SESSION_TTL_HOURS` | `720` | Session lifetime |
