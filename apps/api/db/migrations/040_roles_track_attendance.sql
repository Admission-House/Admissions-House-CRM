-- Whether signing in counts as attendance is now a setting of the role of its own. Until now it followed "must sign in
-- from the office", so a Super Admin, who signs in from anywhere, had no attendance. Now a role can record attendance
-- without being tied to the office. Every role that must sign in from the office still records it, and so does the
-- Super Admin role of each company.
ALTER TABLE roles ADD COLUMN tracks_attendance boolean NOT NULL DEFAULT false;
UPDATE roles SET tracks_attendance = (requires_office OR system_key = 'super_admin');
ALTER TABLE roles ADD CONSTRAINT roles_office_means_attendance CHECK (NOT requires_office OR tracks_attendance);
