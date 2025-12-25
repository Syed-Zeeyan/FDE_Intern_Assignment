import { google, sheets_v4 } from 'googleapis';
import { GaxiosResponse } from 'gaxios';
import { getGoogleSheetsCredentials, config } from '../config';
import logger from '../utils/logger';
import { CircuitBreaker } from '../utils/circuit-breaker';
import { retry, isRetryableError } from '../utils/retry';
import { RateLimiter } from './rate-limiter';
import { incrementAPICounter } from '../utils/metrics';

/**
 * Google Sheets adapter with rate limiting and circuit breaker
 */
export class GoogleSheetsAdapter {
    private sheets: sheets_v4.Sheets;
    private rateLimiter: RateLimiter;
    private circuitBreaker: CircuitBreaker;

    constructor() {
        // Initialize Google Sheets API client
        const credentials = getGoogleSheetsCredentials();
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        this.sheets = google.sheets({ version: 'v4', auth });

        // Initialize rate limiter (100 requests / 100 seconds)
        this.rateLimiter = new RateLimiter(
            'google-sheets',
            config.GOOGLE_SHEETS_RATE_LIMIT,
            config.GOOGLE_SHEETS_RATE_LIMIT / config.GOOGLE_SHEETS_RATE_WINDOW_SECONDS
        );

        // Initialize circuit breaker
        this.circuitBreaker = new CircuitBreaker('google-sheets', {
            failureThreshold: config.CIRCUIT_BREAKER_THRESHOLD,
            timeout: config.CIRCUIT_BREAKER_TIMEOUT_MS,
            successThreshold: 2,
            windowDuration: 60000,
        });

        logger.info('Google Sheets adapter initialized');
    }

    /**
     * Get range data with conditional request support
     */
    async getRange(
        spreadsheetId: string,
        range: string,
        options?: { ifNoneMatch?: string }
    ): Promise<{
        values: unknown[][];
        etag: string;
        notModified: boolean;
    }> {
        await this.rateLimiter.acquire();

        return await this.circuitBreaker.execute(async () => {
            return await retry(
                async () => {
                    const headers: Record<string, string> = {};
                    if (options?.ifNoneMatch) {
                        headers['If-None-Match'] = options.ifNoneMatch;
                    }

                    try {
                        const response = await this.sheets.spreadsheets.values.get({
                            spreadsheetId,
                            range,
                            headers,
                        });

                        incrementAPICounter('google_sheets', response.status.toString());

                        return {
                            values: response.data.values || [],
                            etag: response.headers.etag || '',
                            notModified: false,
                        };
                    } catch (error: unknown) {
                        // Handle 304 Not Modified
                        if (
                            error &&
                            typeof error === 'object' &&
                            'code' in error &&
                            error.code === 304
                        ) {
                            incrementAPICounter('google_sheets', '304');
                            return {
                                values: [],
                                etag: options?.ifNoneMatch || '',
                                notModified: true,
                            };
                        }

                        incrementAPICounter('google_sheets', 'error');
                        throw error;
                    }
                },
                {
                    maxAttempts: config.MAX_RETRY_ATTEMPTS,
                    retryableErrors: isRetryableError,
                },
                { spreadsheetId, range }
            );
        });
    }

    /**
     * Batch update cells
     */
    async batchUpdate(
        spreadsheetId: string,
        updates: Array<{
            range: string;
            values: unknown[][];
        }>
    ): Promise<void> {
        if (updates.length === 0) return;

        // Each batchUpdate counts as one API call
        await this.rateLimiter.acquire();

        await this.circuitBreaker.execute(async () => {
            return await retry(
                async () => {
                    const response = await this.sheets.spreadsheets.values.batchUpdate({
                        spreadsheetId,
                        requestBody: {
                            valueInputOption: 'USER_ENTERED',
                            data: updates,
                        },
                    });

                    incrementAPICounter('google_sheets', response.status.toString());

                    logger.debug(
                        { spreadsheetId, updatesCount: updates.length },
                        'Batch update completed'
                    );
                },
                {
                    maxAttempts: config.MAX_RETRY_ATTEMPTS,
                    retryableErrors: isRetryableError,
                },
                { spreadsheetId, updatesCount: updates.length }
            );
        });
    }

    /**
     * Append rows to sheet
     */
    async appendRows(
        spreadsheetId: string,
        range: string,
        rows: unknown[][]
    ): Promise<void> {
        if (rows.length === 0) return;

        await this.rateLimiter.acquire();

        await this.circuitBreaker.execute(async () => {
            return await retry(
                async () => {
                    const response = await this.sheets.spreadsheets.values.append({
                        spreadsheetId,
                        range,
                        valueInputOption: 'USER_ENTERED',
                        requestBody: {
                            values: rows,
                        },
                    });

                    incrementAPICounter('google_sheets', response.status.toString());

                    logger.debug(
                        { spreadsheetId, range, rowsCount: rows.length },
                        'Appended rows'
                    );
                },
                {
                    maxAttempts: config.MAX_RETRY_ATTEMPTS,
                    retryableErrors: isRetryableError,
                },
                { spreadsheetId, range, rowsCount: rows.length }
            );
        });
    }

    /**
     * Clear a range
     */
    async clearRange(spreadsheetId: string, range: string): Promise<void> {
        await this.rateLimiter.acquire();

        await this.circuitBreaker.execute(async () => {
            return await retry(
                async () => {
                    const response = await this.sheets.spreadsheets.values.clear({
                        spreadsheetId,
                        range,
                    });

                    incrementAPICounter('google_sheets', response.status.toString());

                    logger.debug({ spreadsheetId, range }, 'Cleared range');
                },
                {
                    maxAttempts: config.MAX_RETRY_ATTEMPTS,
                    retryableErrors: isRetryableError,
                },
                { spreadsheetId, range }
            );
        });
    }

    /**
     * Update specific cells by row index
     */
    async updateRows(
        spreadsheetId: string,
        sheetName: string,
        updates: Array<{ rowIndex: number; values: unknown[] }>
    ): Promise<void> {
        if (updates.length === 0) return;

        const batchUpdates = updates.map((update) => ({
            range: `${sheetName}!A${update.rowIndex + 1}`,
            values: [update.values],
        }));

        await this.batchUpdate(spreadsheetId, batchUpdates);
    }

    /**
     * Delete rows (by clearing them - Google Sheets API doesn't support true deletion easily)
     */
    async deleteRows(
        spreadsheetId: string,
        sheetName: string,
        rowIndices: number[]
    ): Promise<void> {
        if (rowIndices.length === 0) return;

        // Clear each row
        const clearRequests = rowIndices.map((rowIndex) => ({
            range: `${sheetName}!A${rowIndex + 1}:Z${rowIndex + 1}`, // Assumes max 26 columns
            values: [[]], // Empty row
        }));

        await this.batchUpdate(spreadsheetId, clearRequests);
        logger.debug({ spreadsheetId, rowsCount: rowIndices.length }, 'Deleted rows');
    }

    /**
     * Get spreadsheet metadata
     */
    async getSpreadsheetMetadata(spreadsheetId: string): Promise<{
        title: string;
        sheets: Array<{ title: string; sheetId: number }>;
    }> {
        await this.rateLimiter.acquire();

        return await this.circuitBreaker.execute(async () => {
            return await retry(
                async () => {
                    const response = await this.sheets.spreadsheets.get({
                        spreadsheetId,
                    });

                    incrementAPICounter('google_sheets', response.status.toString());

                    return {
                        title: response.data.properties?.title || '',
                        sheets:
                            response.data.sheets?.map((sheet) => ({
                                title: sheet.properties?.title || '',
                                sheetId: sheet.properties?.sheetId || 0,
                            })) || [],
                    };
                },
                {
                    maxAttempts: config.MAX_RETRY_ATTEMPTS,
                    retryableErrors: isRetryableError,
                },
                { spreadsheetId }
            );
        });
    }

    /**
     * Get circuit breaker state
     */
    getCircuitBreakerState() {
        return this.circuitBreaker.getState();
    }

    /**
     * Get available rate limit tokens
     */
    getRateLimitTokens() {
        return this.rateLimiter.getTokens();
    }
}

// Global instance
export const googleSheetsAdapter = new GoogleSheetsAdapter();
export default googleSheetsAdapter;
