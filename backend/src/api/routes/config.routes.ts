import express, { Request, Response } from 'express';
import { metadataDB } from '../../database/metadata-db';
import logger from '../../utils/logger';
import { z } from 'zod';
import { ConflictStrategy } from '../../types';
import { googleSheetsAdapter } from '../../adapters/google-sheets.adapter';
import { MySQLAdapter } from '../../adapters/mysql.adapter';
import { getWebSocketServer } from '../../websocket/sync-events';
/**
 * Sync Configuration API Routes
 * 
 *DEMO MODE: Config creation triggers immediate sync execution
 */

const router = express.Router();

// Validation schema
const createConfigSchema = z.object({
    name: z.string().optional(),
    sheet_id: z.string().min(1),
    sheet_range: z.string().optional(),
    db_connection_string: z.string().optional(),
    db_table_name: z.string().min(1),
    column_mapping: z.record(z.string()).optional(),
    conflict_strategy: z.nativeEnum(ConflictStrategy).optional(),
    sync_interval_seconds: z.number().optional(),
});

/**
 * Create config AND execute sync immediately (DEMO MODE)
 */
router.post('/', async (req: Request, res: Response) => {
    const startTime = Date.now();

    try {
        console.log('=== SYNC REQUEST START ===');
        console.log('REQ BODY:', JSON.stringify(req.body, null, 2));

        const validatedData = createConfigSchema.parse(req.body);
        console.log('VALIDATION PASSED');

        // Create config with defaults
        const config = await metadataDB.createSyncConfig({
            name: validatedData.name || 'QuickSync',
            sheet_id: validatedData.sheet_id,
            sheet_range: validatedData.sheet_range || 'Sheet1',
            db_connection_string: validatedData.db_connection_string ||
                'mysql://root:mysql_dev_password@localhost:3306/test_database',
            db_table_name: validatedData.db_table_name,
            column_mapping: validatedData.column_mapping || { A: 'id', B: 'name', C: 'email' },
            conflict_strategy: validatedData.conflict_strategy || ConflictStrategy.LAST_WRITE_WINS,
            sync_interval_seconds: validatedData.sync_interval_seconds || 30,
            is_active: true,
        });

        console.log('CONFIG CREATED:', config.id);
        logger.info({ configId: config.id }, 'Config created - executing sync NOW');
        const wsServer = getWebSocketServer();
        if (wsServer) {
            wsServer.emitSyncStarted({
                configId: config.id!,
                syncId: `sync-${Date.now()}`,
                direction: 'sheet_to_db',
            });
        }
        // INLINE SYNC EXECUTION
        try {
            // Fetch from Google Sheets
            console.log('FETCHING FROM SHEET:', config.sheet_id, config.sheet_range);
            logger.info({ sheetId: config.sheet_id, range: config.sheet_range }, 'Fetching from Sheet...');

            const sheetData = await googleSheetsAdapter.getRange(config.sheet_id, config.sheet_range);
            console.log('SHEET DATA FETCHED:', sheetData.values?.length, 'rows');

            if (!sheetData.values || sheetData.values.length === 0) {
                throw new Error('Sheet is empty or has no data');
            }

            // Extract headers and rows
            const headers = sheetData.values[0] as string[];
            const dataRows = sheetData.values.slice(1);

            console.log('HEADERS:', headers);
            console.log('DATA ROWS COUNT:', dataRows.length);
            logger.info({ rowCount: dataRows.length, headers }, 'Fetched sheet data');

            // Connect to MySQL
            console.log('CONNECTING TO MYSQL:', config.db_connection_string);
            const mysqlAdapter = new MySQLAdapter(config.db_connection_string);
            await mysqlAdapter.connect();
            console.log('MYSQL CONNECTED');

            // Insert rows
            let inserted = 0;
            console.log('STARTING ROW INSERTION INTO TABLE:', config.db_table_name);

            for (const row of dataRows) {
                const rowData: Record<string, any> = {};

                // Map columns by index (A=0, B=1, C=2...)
                headers.forEach((header, index) => {
                    const dbColumn = config.column_mapping[String.fromCharCode(65 + index)] || header.toLowerCase();
                    rowData[dbColumn] = row[index] || null;
                });

                console.log('INSERTING ROW:', rowData);
                await mysqlAdapter.insert(config.db_table_name, rowData);
                inserted++;
                console.log('ROWS INSERTED SO FAR:', inserted);
            }

            await mysqlAdapter.close();
            console.log('MYSQL CLOSED, TOTAL INSERTED:', inserted);

            // Update sync state
            // await metadataDB.updateSyncState(config.id!, {
            //     last_sheet_sync_at: new Date(),
            //     last_etag: sheetData.etag,
            // });

            const duration = Date.now() - startTime;
            console.log('SYNC DURATION:', duration, 'ms');

            logger.info({ configId: config.id, rowsAffected: inserted, duration }, 'Sync completed successfully');
            if (wsServer) {
                wsServer.emitSyncCompleted({
                    configId: config.id!,
                    syncId: `sync-${Date.now()}`,
                    direction: 'sheet_to_db',
                    rowsAffected: inserted,
                    conflicts: 0,
                    duration,
                });
            }

            res.status(201).json({
                success: true,
                message: 'Sync executed successfully',
                data: {
                    config,
                    syncResult: {
                        rowsAffected: inserted,
                        duration,
                    },
                },
            });

        } catch (syncError) {
            console.error('SYNC ERROR:', syncError);
            console.error('SYNC ERROR STACK:', syncError instanceof Error ? syncError.stack : 'no stack');

            throw syncError;
        }

    } catch (error) {
        console.error('=== ROUTE ERROR ===');
        console.error('ERROR:', error);
        console.error('ERROR STACK:', error instanceof Error ? error.stack : 'no stack');

        if (error instanceof z.ZodError) {
            console.error('VALIDATION ERROR:', error.errors);
            return res.status(400).json({
                success: false,
                error: 'Validation error',
                details: error.errors,
            });
        }

        logger.error({ error }, 'Sync execution failed');
        res.status(500).json({
            success: false,
            error: 'Sync execution failed',
            message: error instanceof Error ? error.message : 'Unknown error',
        });
    }
});

/**
 * List all configs
 */
router.get('/', async (req: Request, res: Response) => {
    try {
        const activeOnly = req.query.active === 'true';
        const configs = await metadataDB.getAllSyncConfigs(activeOnly);

        res.json({
            success: true,
            count: configs.length,
            data: configs,
        });
    } catch (error) {
        logger.error({ error }, 'Failed to list configs');
        res.status(500).json({
            success: false,
            error: 'Failed to list configs',
        });
    }
});

/**
 * Get specific config
 */
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const config = await metadataDB.getSyncConfig(req.params.id);

        if (!config) {
            return res.status(404).json({
                success: false,
                error: 'Config not found',
            });
        }

        res.json({
            success: true,
            data: config,
        });
    } catch (error) {
        logger.error({ error, configId: req.params.id }, 'Failed to get config');
        res.status(500).json({
            success: false,
            error: 'Failed to get config',
        });
    }
});

/**
 * Update config
 */
router.put('/:id', async (req: Request, res: Response) => {
    try {
        const updates = req.body;
        const config = await metadataDB.updateSyncConfig(req.params.id, updates);

        logger.info({ configId: req.params.id }, 'Config updated');

        res.json({
            success: true,
            message: 'Config updated successfully',
            data: config,
        });
    } catch (error) {
        logger.error({ error, configId: req.params.id }, 'Failed to update config');
        res.status(500).json({
            success: false,
            error: 'Failed to update config',
        });
    }
});

/**
 * Delete config
 */
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        await metadataDB.deleteSyncConfig(req.params.id);

        logger.info({ configId: req.params.id }, 'Config deleted');

        res.json({
            success: true,
            message: 'Config deleted successfully',
        });
    } catch (error) {
        logger.error({ error, configId: req.params.id }, 'Failed to delete config');
        res.status(500).json({
            success: false,
            error: 'Failed to delete config',
        });
    }
});

export default router;
