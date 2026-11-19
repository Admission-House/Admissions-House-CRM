-- An office on an internet connection whose address changes can be named by a dynamic DNS hostname instead of a fixed
-- address. The router keeps the hostname pointing at the connection's current address, and a sign-in is accepted when it
-- comes from the address the hostname points to at that moment. Only the office's own address is allowed, never a wide range.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'branch_networks'::regclass AND contype = 'c' LOOP
    EXECUTE format('ALTER TABLE branch_networks DROP CONSTRAINT %I', c);
  END LOOP;
END
$$;

ALTER TABLE branch_networks ADD COLUMN hostname text;
ALTER TABLE branch_networks ADD CONSTRAINT branch_networks_shape CHECK (
  kind IN ('ip_range', 'wifi', 'ddns') AND (
    (kind = 'ip_range' AND ip_range IS NOT NULL AND wifi_id IS NULL AND hostname IS NULL) OR
    (kind = 'wifi' AND wifi_id IS NOT NULL AND ip_range IS NULL AND hostname IS NULL) OR
    (kind = 'ddns' AND hostname IS NOT NULL AND ip_range IS NULL AND wifi_id IS NULL)
  )
);
CREATE UNIQUE INDEX branch_networks_ddns_uq ON branch_networks (branch_id, hostname) WHERE hostname IS NOT NULL;
