-- Deleting a person (requirement USR-1), without giving the application role the right to delete
-- from users. That right is withheld on purpose: people are deactivated so their history stays.
--
-- This function removes only an account that was added by mistake: it belongs to the current
-- company, the person never signed in, and nothing else refers to them. It returns false, and
-- changes nothing, when the person has any history.

CREATE FUNCTION delete_unused_user(p_user_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  removed integer;
BEGIN
  IF current_tenant_id() IS NULL THEN
    RETURN false;
  END IF;
  -- Rows created together with the account carry no history of their own.
  DELETE FROM user_profiles        WHERE user_id = p_user_id AND tenant_id = current_tenant_id();
  DELETE FROM leave_balances       WHERE user_id = p_user_id AND tenant_id = current_tenant_id();
  DELETE FROM notifications        WHERE user_id = p_user_id AND tenant_id = current_tenant_id();
  DELETE FROM assignment_rule_users WHERE user_id = p_user_id AND tenant_id = current_tenant_id();
  DELETE FROM password_reset_tokens WHERE user_id = p_user_id AND tenant_id = current_tenant_id();
  DELETE FROM users
   WHERE id = p_user_id AND tenant_id = current_tenant_id() AND last_login_at IS NULL;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed = 1;
EXCEPTION WHEN foreign_key_violation THEN
  -- Anything that refers to the person (a lead, a login attempt, a salary) means they have history.
  -- The block's own changes are undone.
  RETURN false;
END
$$;

REVOKE ALL ON FUNCTION delete_unused_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_unused_user(uuid) TO ah_app;
