#!/bin/sh
set -eu

mkdir -p /etc/pgbouncer /tmp/pgbouncer
touch /etc/pgbouncer/userlist.txt

cat > /etc/pgbouncer/pgbouncer.ini <<EOF
[databases]
experiment = host=${DB_HOST} port=5432 dbname=${DB_NAME} user=postgres

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 5432
auth_type = any
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = ${POOL_MODE}
max_client_conn = 200
default_pool_size = ${DEFAULT_POOL_SIZE}
server_reset_query = DISCARD ALL
server_reset_query_always = ${SERVER_RESET_QUERY_ALWAYS}
ignore_startup_parameters = extra_float_digits
admin_users = postgres
stats_users = postgres
pidfile = /tmp/pgbouncer/pgbouncer.pid
unix_socket_dir = /tmp/pgbouncer
user = pgbouncer
EOF

chown -R pgbouncer:pgbouncer /etc/pgbouncer /tmp/pgbouncer
exec pgbouncer /etc/pgbouncer/pgbouncer.ini
