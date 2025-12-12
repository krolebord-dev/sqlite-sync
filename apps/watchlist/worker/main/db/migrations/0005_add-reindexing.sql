ALTER TABLE `list_items` ADD `type` text DEFAULT 'movie' NOT NULL;
ALTER TABLE `list_items` ADD `episodeCount` integer;
ALTER TABLE `list_items` ADD `updatedAt` integer;

-- Then, update the updatedAt column with the current timestamp
UPDATE `list_items` SET `updatedAt` = unixepoch();

-- If you want to ensure this column is always updated, you'll need to create a trigger
CREATE TRIGGER IF NOT EXISTS update_list_items_timestamp
AFTER UPDATE ON `list_items`
FOR EACH ROW
BEGIN
    UPDATE `list_items` SET `updatedAt` = unixepoch() WHERE id = NEW.id;
END;

-- For new inserts
CREATE TRIGGER IF NOT EXISTS insert_list_items_timestamp
AFTER INSERT ON `list_items`
FOR EACH ROW
BEGIN
    UPDATE `list_items` SET `updatedAt` = unixepoch() WHERE id = NEW.id;
END;
