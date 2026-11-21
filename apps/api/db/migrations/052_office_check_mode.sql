-- How an office sign-in is checked, per office.
--   address_and_location : the computer must be on an office internet address (or be a registered office computer) and at the office.
--   location_only        : being at the office (the person's position, within the office's radius) is the proof; the internet address is
--                          not looked at. For an office whose internet provider changes the address all the time and that has no
--                          fixed address. The position is still checked for accuracy and for faked locations.
ALTER TABLE branches ADD COLUMN office_check text NOT NULL DEFAULT 'address_and_location' CHECK (office_check IN ('address_and_location', 'location_only'));
