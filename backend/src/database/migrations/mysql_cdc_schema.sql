-- MySQL target database schema
-- This migration creates the __sync_change_log table and helper procedures

-- Change log table for CDC
CREATE TABLE IF NOT EXISTS __sync_change_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    table_name VARCHAR(255) NOT NULL,
    operation VARCHAR(10) NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
    row_data JSON NOT NULL,
    source_tag VARCHAR(50),
    changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed BOOLEAN DEFAULT FALSE,
    INDEX idx_processed (processed, changed_at),
    INDEX idx_table_processed (table_name, processed, changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Procedure to create triggers for a table
DROP PROCEDURE IF EXISTS create_sync_triggers;

DELIMITER $$

CREATE PROCEDURE create_sync_triggers(
    IN target_table VARCHAR(255),
    IN pk_column VARCHAR(255)
)
BEGIN
    SET @drop_insert = CONCAT('DROP TRIGGER IF EXISTS ', target_table, '_sync_insert');
    SET @drop_update = CONCAT('DROP TRIGGER IF EXISTS ', target_table, '_sync_update');
    SET @drop_delete = CONCAT('DROP TRIGGER IF EXISTS ', target_table, '_sync_delete');
    
    PREPARE stmt FROM @drop_insert;
    EXECUTE stmt;
    PREPARE stmt FROM @drop_update;
    EXECUTE stmt;
    PREPARE stmt FROM @drop_delete;
    EXECUTE stmt;
    
    -- INSERT trigger
    SET @create_insert = CONCAT(
        'CREATE TRIGGER ', target_table, '_sync_insert ',
        'AFTER INSERT ON ', target_table, ' ',
        'FOR EACH ROW ',
        'BEGIN ',
            'DECLARE source_tag_var VARCHAR(50); ',
            'SET source_tag_var = COALESCE(@sync_source_tag, ''external''); ',
            'INSERT INTO __sync_change_log (table_name, operation, row_data, source_tag) ',
            'VALUES (''', target_table, ''', ''INSERT'', ',
            'JSON_OBJECT(''', pk_column, ''', NEW.', pk_column, ', ''_full'', JSON_EXTRACT(JSON_OBJECT(',
            '@@placeholder@@', '), ''$'')), source_tag_var); ',
        'END'
    );
    
    -- UPDATE trigger  
    SET @create_update = CONCAT(
        'CREATE TRIGGER ', target_table, '_sync_update ',
        'AFTER UPDATE ON ', target_table, ' ',
        'FOR EACH ROW ',
        'BEGIN ',
            'DECLARE source_tag_var VARCHAR(50); ',
            'SET source_tag_var = COALESCE(@sync_source_tag, ''external''); ',
            'INSERT INTO __sync_change_log (table_name, operation, row_data, source_tag) ',
            'VALUES (''', target_table, ''', ''UPDATE'', ',
            'JSON_OBJECT(''', pk_column, ''', NEW.', pk_column, ', ''_full'', JSON_EXTRACT(JSON_OBJECT(',
            '@@placeholder@@', '), ''$'')), source_tag_var); ',
        'END'
    );
    
    -- DELETE trigger
    SET @create_delete = CONCAT(
        'CREATE TRIGGER ', target_table, '_sync_delete ',
        'AFTER DELETE ON ', target_table, ' ',
        'FOR EACH ROW ',
        'BEGIN ',
            'DECLARE source_tag_var VARCHAR(50); ',
            'SET source_tag_var = COALESCE(@sync_source_tag, ''external''); ',
            'INSERT INTO __sync_change_log (table_name, operation, row_data, source_tag) ',
            'VALUES (''', target_table, ''', ''DELETE'', ',
            'JSON_OBJECT(''', pk_column, ''', OLD.', pk_column, '), source_tag_var); ',
        'END'
    );
    
    -- Note: @@placeholder@@ should be replaced with actual column JSON pairs by the application
    -- Example: "'id', NEW.id, 'name', NEW.name, 'email', NEW.email"
    
    SELECT 'Trigger creation SQL generated. Replace @@placeholder@@ with column mapping.' AS message;
    SELECT @create_insert AS insert_trigger_sql;
    SELECT @create_update AS update_trigger_sql;
    SELECT @create_delete AS delete_trigger_sql;
END$$

DELIMITER ;

-- Procedure to drop triggers
DROP PROCEDURE IF EXISTS drop_sync_triggers;

DELIMITER $$

CREATE PROCEDURE drop_sync_triggers(
    IN target_table VARCHAR(255)
)
BEGIN
    SET @drop_insert = CONCAT('DROP TRIGGER IF EXISTS ', target_table, '_sync_insert');
    SET @drop_update = CONCAT('DROP TRIGGER IF EXISTS ', target_table, '_sync_update');
    SET @drop_delete = CONCAT('DROP TRIGGER IF EXISTS ', target_table, '_sync_delete');
    
    PREPARE stmt FROM @drop_insert;
    EXECUTE stmt;
    PREPARE stmt FROM @drop_update;
    EXECUTE stmt;
    PREPARE stmt FROM @drop_delete;
    EXECUTE stmt;
    
    SELECT CONCAT('Triggers dropped for table: ', target_table) AS message;
END$$

DELIMITER ;

-- Mark change log entries as processed
-- (Called by sync workers after successfully syncing to Google Sheets)

COMMENT ON TABLE __sync_change_log IS 'CDC change log for tracking MySQL data changes to sync to Google Sheets';
