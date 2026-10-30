-- A user created with a generated password must choose their own on the first sign-in.
ALTER TABLE users
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false,
  ADD COLUMN password_changed_at  timestamptz;
