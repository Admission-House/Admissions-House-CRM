-- Which statuses a person may choose when disposing a lead. A company keeps statuses the system itself uses (a new lead is "New",
-- a missed call is "Missed Call") and older ones that still hold leads, but offers only its own disposition list to choose from.
ALTER TABLE lead_statuses ADD COLUMN selectable boolean NOT NULL DEFAULT true;
