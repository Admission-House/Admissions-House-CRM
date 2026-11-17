-- Where a lead came from (the source, the form, the campaign) is for the people who run the business, not for the
-- counsellor who works the lead. A permission of its own lets a company decide who sees it. It starts with the Super
-- Admin and the Admin; the Counsellor does not have it.
INSERT INTO permissions (code, module, description) VALUES
  ('lead.source', 'lead', 'See where a lead came from: its source, form and campaign');
INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT r.tenant_id, r.id, p.id
FROM roles r CROSS JOIN permissions p
WHERE r.system_key IN ('super_admin', 'admin') AND p.code = 'lead.source'
ON CONFLICT DO NOTHING;
