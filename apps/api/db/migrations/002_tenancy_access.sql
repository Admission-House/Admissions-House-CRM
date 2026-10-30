-- Tenancy and access: companies, offices, roles, users, devices and sessions.
-- Convention: every tenant table has UNIQUE (tenant_id, id) so that children can use a composite
-- foreign key (tenant_id, parent_id). That makes a cross-tenant reference impossible.

CREATE TABLE tenants (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  name       text NOT NULL CHECK (length(btrim(name)) > 0),
  slug       citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  plan       text NOT NULL DEFAULT 'standard',
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  timezone   text NOT NULL DEFAULT 'Asia/Kolkata',
  settings   jsonb NOT NULL DEFAULT '{}'::jsonb,   -- branding and small switches only
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  name        text NOT NULL,
  address     text,
  latitude    numeric(9, 6) CHECK (latitude BETWEEN -90 AND 90),
  longitude   numeric(9, 6) CHECK (longitude BETWEEN -180 AND 180),
  radius_m    integer NOT NULL DEFAULT 200 CHECK (radius_m BETWEEN 20 AND 5000),
  detected_at timestamptz,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  CHECK ((latitude IS NULL) = (longitude IS NULL))
);

-- A branch can have many allowed networks: an IP range or a WiFi identifier, never both.
CREATE TABLE branch_networks (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL,
  branch_id  uuid NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('ip_range', 'wifi')),
  ip_range   cidr,
  wifi_id    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id) ON DELETE CASCADE,
  CHECK (
    (kind = 'ip_range' AND ip_range IS NOT NULL AND wifi_id IS NULL) OR
    (kind = 'wifi' AND wifi_id IS NOT NULL AND ip_range IS NULL)
  )
);
CREATE INDEX branch_networks_branch_idx ON branch_networks (tenant_id, branch_id);
CREATE UNIQUE INDEX branch_networks_ip_uq ON branch_networks (branch_id, ip_range) WHERE ip_range IS NOT NULL;
CREATE UNIQUE INDEX branch_networks_wifi_uq ON branch_networks (branch_id, wifi_id) WHERE wifi_id IS NOT NULL;

-- Roles are per tenant. system_key marks the three standard roles so code never depends on names.
-- data_scope and requires_office are settings of the role, not hard-coded rules.
CREATE TABLE roles (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  name            text NOT NULL,
  system_key      text CHECK (system_key IN ('super_admin', 'admin', 'counsellor')),
  data_scope      text NOT NULL CHECK (data_scope IN ('all', 'team', 'own')),
  requires_office boolean NOT NULL DEFAULT true,
  is_system       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  CHECK (is_system = (system_key IS NOT NULL))
);
CREATE UNIQUE INDEX roles_system_key_uq ON roles (tenant_id, system_key) WHERE system_key IS NOT NULL;

-- Master list of permission codes, shared by every tenant.
CREATE TABLE permissions (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[a-z_]+\.[a-z_]+$'),
  module      text NOT NULL,
  description text NOT NULL
);

CREATE TABLE role_permissions (
  tenant_id     uuid NOT NULL,
  role_id       uuid NOT NULL,
  permission_id uuid NOT NULL REFERENCES permissions (id),
  PRIMARY KEY (role_id, permission_id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX role_permissions_tenant_idx ON role_permissions (tenant_id);

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  branch_id        uuid,
  role_id          uuid NOT NULL,
  manager_id       uuid,                              -- the Admin of a Counsellor
  name             text NOT NULL CHECK (length(btrim(name)) > 0),
  email            citext NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone            text CHECK (phone ~ '^[0-9]{8,15}$'),
  password_hash    text NOT NULL,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  joined_on        date,
  last_login_at    timestamptz,
  failed_logins    smallint NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  locked_until     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, email),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id),
  FOREIGN KEY (tenant_id, manager_id) REFERENCES users (tenant_id, id),
  CHECK (manager_id IS NULL OR manager_id <> id)
);
CREATE INDEX users_manager_idx ON users (tenant_id, manager_id) WHERE manager_id IS NOT NULL;
CREATE INDEX users_branch_idx ON users (tenant_id, branch_id);
CREATE INDEX users_role_idx ON users (tenant_id, role_id);

-- Employee details kept apart from the login record. Bank fields hold application-level ciphertext.
CREATE TABLE user_profiles (
  tenant_id               uuid NOT NULL,
  user_id                 uuid PRIMARY KEY,
  designation             text,
  date_of_birth           date,
  address                 text,
  emergency_contact_name  text,
  emergency_contact_phone text CHECK (emergency_contact_phone ~ '^[0-9]{8,15}$'),
  bank_name               text,
  bank_account_no_enc     text,
  bank_ifsc_enc           text,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);

-- Mobile devices bound to a user. A new device needs approval before it can sign in.
CREATE TABLE user_devices (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL,
  user_id            uuid NOT NULL,
  device_fingerprint text NOT NULL,
  platform           text NOT NULL CHECK (platform IN ('android', 'ios')),
  label              text,
  approved_by        uuid,
  approved_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (user_id, device_fingerprint),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, approved_by) REFERENCES users (tenant_id, id),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL))
);

-- One row per signed-in device or browser. Refresh tokens rotate; the previous hash is kept only
-- to detect reuse of a stolen token, which ends the whole session.
CREATE TABLE user_sessions (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id               uuid NOT NULL,
  user_id                 uuid NOT NULL,
  device_id               uuid,
  refresh_token_hash      text NOT NULL,
  prev_refresh_token_hash text,
  ip                      inet,
  user_agent              text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  last_active_at          timestamptz NOT NULL DEFAULT now(),
  expires_at              timestamptz NOT NULL,
  ended_at                timestamptz,
  ended_reason            text CHECK (ended_reason IN ('logout', 'inactivity', 'revoked', 'expired', 'reuse_detected')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, device_id) REFERENCES user_devices (tenant_id, id),
  CHECK ((ended_at IS NULL) = (ended_reason IS NULL))
);
CREATE INDEX user_sessions_active_user_idx ON user_sessions (tenant_id, user_id) WHERE ended_at IS NULL;
-- The inactivity sweep reads only live sessions, ordered by last activity.
CREATE INDEX user_sessions_idle_idx ON user_sessions (last_active_at) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX user_sessions_refresh_uq ON user_sessions (refresh_token_hash);
