const express = require('express');
const bodyParser = require('body-parser');
const PDFDocument = require('pdfkit-table');
const sqlite3 = require('sqlite3').verbose();
const cors = require("cors");
const path = require('path');
const db = new sqlite3.Database('quotes.db');

// Create the quotes table if it doesn't exist
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quoteName TEXT,
    version INTEGER,
    data TEXT,
    date TEXT,
    total REAL
  )`);
});

const app = express();

// --- Express App Setup ---
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json());
app.use(cors());

// --- Pricing Data (Server-Side) ---
const pricingData = {
    frameHeadCostPerMm: 5.63 / 506,
    frameSillCostPerMm: 6.69 / 506,
    frameJambCostPerMm: 31.47 / (2 * 1781),
    mullionCostPerMm: 31.47 / (2 * 1781),
    glassCostPerSqMm: 32.26 / (1675.1 * 428),
    powderCoatingPerMm: (2.17 + 2.17 + 15.27) / (506 + 506 + (2 * 1781)),
    fixedCosts: { awning: 80.83 + 1.94 + (0.53 + 1.84) + (0.39 + 1.36), sliding: 70.00, fixed: 5.00 },
    glazingMultipliers: { single_glazed: 1.0, toughened: 1.4, double_glazed: 1.8, acoustic: 2.2 },
    wasteAndProfitMarkup: 436.568 / 208.79,
    factoryBuildCostPerWindow: 750,
    installationCostPerWindow: 800
};

const paneTypeMap = { 'A': 'awning', 'F': 'fixed', 'S': 'sliding' };
const glazingTypeMap = {
    'single_glazed': '6mm Laminated (Standard)',
    'toughened': '6mm Toughened',
    'double_glazed': 'Double Glazed',
    'acoustic': 'Acoustic Glazed'
};

// --- ROUTES ---
// Render the main page
app.get('/', (req, res) => {
    res.render('index');
});

// API endpoint for calculating price
app.post('/calculate', (req, res) => {
    const calc = calculateInternal(req.body);
    res.json(calc);
});

// API endpoint for saving a quote
app.post('/save-quote', (req, res) => {
    const { quoteName, ...data } = req.body;
    if (!quoteName) return res.status(400).send("Quote name is required.");

    db.get('SELECT MAX(version) as maxVer FROM quotes WHERE quoteName = ?', [quoteName], (err, row) => {
        if (err) return res.status(500).send(err.message);
        const version = (row && row.maxVer ? row.maxVer : 0) + 1;
        const date = new Date().toISOString();
        const calc = calculateInternal(req.body);
        const total = calc.final;
        db.run('INSERT INTO quotes (quoteName, version, data, date, total) VALUES (?, ?, ?, ?, ?)',
            [quoteName, version, JSON.stringify(data), date, total],
            function (err) {
                if (err) return res.status(500).send(err.message);
                res.json({ id: this.lastID, version });
            }
        );
    });
});

// API endpoint to get all quotes
app.get('/quotes', (req, res) => {
    db.all('SELECT * FROM quotes ORDER BY quoteName, version DESC', (err, rows) => {
        if (err) return res.status(500).send(err.message);
        res.json(rows);
    });
});

// API endpoint to get a single quote by ID
app.get('/quote/:id', (req, res) => {
    db.get('SELECT * FROM quotes WHERE id = ?', [req.params.id], (err, row) => {
        if (err) return res.status(500).send(err.message);
        if (!row) return res.status(404).send('Quote not found');
        res.json(row);
    });
});

// API endpoint to delete a quote by ID
app.delete('/quote/:id', (req, res) => {
    db.run('DELETE FROM quotes WHERE id = ?', [req.params.id], function (err) {
        if (err) return res.status(500).send(err.message);
        if (this.changes === 0) return res.status(404).send('Quote not found');
        res.json({ message: 'Quote deleted successfully' });
    });
});

// --- PDF Generation Endpoint ---
app.get('/pdf/:id/:type', (req, res) => {
    const { id, type } = req.params;
    if (!['customer', 'sales', 'production'].includes(type)) return res.status(400).send('Invalid type');

    db.get('SELECT * FROM quotes WHERE id = ?', [id], (err, row) => {
        if (err) return res.status(500).send(err.message);
        if (!row) return res.status(404).send('Quote not found');

        const completeData = { quoteName: row.quoteName, ...JSON.parse(row.data) };
        const calc = calculateInternal(completeData);

        const doc = new PDFDocument({
            margin: 50,
            size: 'A4',
            bufferPages: true
        });

        res.setHeader('Content-disposition', `inline; filename=quote-${row.quoteName}-v${row.version}-${type}.pdf`);
        res.setHeader('Content-type', 'application/pdf');
        doc.pipe(res);

        // Try to register custom fonts, fallback to standard if not available
        try {
            doc.registerFont('Bold', path.join(__dirname, 'fonts/Inter-Bold.ttf'));
            doc.registerFont('Regular', path.join(__dirname, 'fonts/Inter-Regular.ttf'));
            doc.registerFont('Italic', path.join(__dirname, 'fonts/Inter-Italic.ttf'));
        } catch (e) {
            console.log('Custom fonts not found, using defaults');
        }

        // Generate content
        generateCoverPage(doc, row, type);
        generateProjectDetails(doc, completeData, type, row);

        if (type === 'production') {
            generateProductionSheets(doc, completeData, row);
        } else {
            generateRoomSchedules(doc, completeData, type, row);
        }

        if (type === 'sales' || type === 'customer') {
            generatePriceBreakdown(doc, calc, type, row);
        }

        generateTermsAndConditions(doc, type, row);

        // Add page numbers after all content is generated
        addPageNumbers(doc);

        // Finalize the document
        doc.end();
    });
});

// --- PDF Helper Functions ---
// FIX: Header and footer drawing is disabled by commenting out the function body.
const addHeaderAndFooter = (doc, quote) => {
    /*
    // Clean white header with subtle border
    doc.rect(0, 0, doc.page.width, 60).fill('#FFFFFF');
    doc.rect(0, 58, doc.page.width, 2).fill('#023047');

    // Logo
    try {
        doc.image(path.join(__dirname, 'caplock-logo.png'), 50, 15, { width: 100 });
    } catch (e) {
        // Logo placeholder if file not found
        doc.fillColor('#023047').fontSize(14).text('CapLock', 50, 25);
    }

    // Company info - right aligned
    doc.fillColor('#023047').fontSize(12).text('CapLock Windows & Doors', 200, 20);
    doc.fillColor('#666666').fontSize(9)
        .text(`Quote: ${quote.quoteName}`, 200, 35)
        .text(`Version ${quote.version} | ${new Date(quote.date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}`, 200, 48);

    // Footer
    const footerY = doc.page.height - 40;
    doc.rect(0, footerY - 2, doc.page.width, 2).fill('#E0E0E0');
    doc.rect(0, footerY, doc.page.width, 40).fill('#F8F9FA');

    doc.fillColor('#666666').fontSize(9)
        .text('123 Window Lane, Buildtown, ST 54321', 50, footerY + 5, { align: 'left', width: doc.page.width - 100 })
        .text('Phone: (555) 123-4567 | Email: sales@caplock.com', 50, footerY + 15, { align: 'left', width: doc.page.width - 100 });
    */
};

// FIX: Page numbers are disabled by commenting out the function body.
const addPageNumbers = (doc) => {
    /*
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
        doc.switchToPage(i);
        const footerY = doc.page.height - 40;
        doc.fillColor('#023047').fontSize(9)
            .text(`Page ${i + 1} of ${range.count}`, 50, footerY + 25, { align: 'right', width: doc.page.width - 100 });
    }
    */
};

// FIX: This function now only adds a new page and resets the cursor position.
const addNewPage = (doc, quote) => {
    doc.addPage();
    // addHeaderAndFooter(doc, quote); // This is disabled.
    doc.y = 50; // Start content at the top margin.
};

const generateCoverPage = (doc, quote, type) => {
    const centerX = doc.page.width / 2;

    // --- NEW: Add Logo ---
    try {
        const logoWidth = 150;
        const logoX = (doc.page.width - logoWidth) / 2; // Center the logo
        doc.image(path.join(__dirname, 'caplock-logo.png'), logoX, 80, {
            width: logoWidth
        });
    } catch (e) {
        console.log('Logo file not found: caplock-logo.png. Skipping logo.');
    }
    // --- End Logo ---

    // ADJUSTED: Moved startY down to make space for the logo
    const startY = 220;

    // Main title
    doc.fillColor('#023047').fontSize(30)
        .text('Window Quotation', 50, startY, { align: 'center', width: doc.page.width - 100 });

    // Decorative line
    doc.rect(centerX - 100, startY + 50, 200, 3).fill('#219ebc');

    // Document type
    doc.fillColor('#666666').fontSize(16)
        .text(`${type.charAt(0).toUpperCase() + type.slice(1)} Version`, 50, startY + 70, { align: 'center', width: doc.page.width - 100 });

    // Quote details box - ADJUSTED Y position
    const boxY = startY + 110;
    doc.roundedRect(centerX - 200, boxY, 400, 80, 10).fillAndStroke('#F8F9FA', '#E0E0E0');

    doc.fillColor('#023047').fontSize(18)
        .text(`${quote.quoteName}`, centerX - 180, boxY + 20, { align: 'center', width: 360 });

    doc.fillColor('#666666').fontSize(11)
        .text(`Quote ID: Q-${quote.id.toString().padStart(5, '0')}-V${quote.version}`, centerX - 180, boxY + 45, { align: 'center', width: 360 })
        .text(`Date Issued: ${new Date(quote.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, centerX - 180, boxY + 60, { align: 'center', width: 360 });

    // Footer text
    doc.fillColor('#023047').fontSize(12)
        .text('Prepared by CapLock Windows', 50, doc.page.height - 100, { align: 'center', width: doc.page.width - 100 });
};


const generateProjectDetails = (doc, data, type, quote) => {
    addNewPage(doc, quote);

    const titleY = doc.y;
    doc.fillColor('#023047').fontSize(16).text('Project Overview', 50, titleY);

    // Decorative underline
    doc.rect(50, titleY + 20, 150, 2).fill('#219ebc'); // IMPROVED: Better spacing
    doc.moveDown(1.5); // IMPROVED: Added more space

    // FIXED: Changed to "window project"
    doc.fillColor('#444444').fontSize(10)
        .text('This document provides detailed specifications for your window project. We strive for excellence in every detail.',
            50, doc.y, { align: 'justify', width: doc.page.width - 100 });
    doc.moveDown(1.5); // IMPROVED: Added more space

    const table = {
        headers: [
            { label: 'Specification', property: 'spec', width: 220, renderer: null },
            { label: 'Details', property: 'details', width: 280, renderer: null }
        ],
        rows: [
            ['Existing Frame Type', data.existingFrame === 'timber' ? 'Timber (-60mm Deduction)' : 'Aluminium (Standard)'],
            ['Default Glazing', glazingTypeMap[data.glazingType] || 'N/A'],
            ['Frame Colour', data.frameColor || 'Not Specified'],
            ['Installation Included', data.installationCosts === 'yes' ? 'Yes' : 'No'],
        ]
    };

    doc.table(table, {
        x: 50,
        prepareHeader: () => doc.fontSize(10).fillColor('#023047'),
        prepareRow: (row, indexColumn, indexRow, rectRow, rectCell) => {
            doc.fontSize(9).fillColor('#333333');
            if (indexRow % 2 === 1) doc.addBackground(rectRow, '#F8F9FA', 1);
        },
        padding: 8, // IMPROVED: Increased padding
        columnSpacing: 5,
        divider: {
            header: { disabled: false, width: 1, opacity: 1, color: '#023047' },
            horizontal: { disabled: false, width: 0.5, opacity: 0.3 }
        }
    });
};

const generateRoomSchedules = (doc, data, type, quote) => {
    doc.moveDown(2);

    const titleY = doc.y;
    doc.fillColor('#023047').fontSize(16).text('Window Schedule', 50, titleY);
    doc.rect(50, titleY + 20, 150, 2).fill('#219ebc'); // IMPROVED: Better spacing
    doc.moveDown(1.5); // IMPROVED: Added more space

    // FIXED: Removed "and doors"
    doc.fillColor('#444444').fontSize(10)
        .text('Detailed schedule of windows per room.', 50, doc.y, { align: 'left', width: doc.page.width - 100 });
    doc.moveDown(1.5); // IMPROVED: Added more space

    data.rooms.forEach((room, roomIdx) => {
        if (doc.y > doc.page.height - 150) {
            addNewPage(doc, quote);
        }

        // Room header with background
        doc.roundedRect(50, doc.y, doc.page.width - 100, 25, 5).fill('#023047');
        doc.fillColor('#FFFFFF').fontSize(11)
            .text(`Room: ${room.name}`, 65, doc.y + 7);
        doc.moveDown(1); // IMPROVED: Added space

        const table = {
            headers: [
                { label: '#', width: 50 },
                { label: 'Style Code', width: 140 },
                { label: 'Width (mm)', width: 100 },
                { label: 'Height (mm)', width: 100 },
                { label: 'Notes', width: 120 }
            ],
            rows: room.windows.map((win, i) => [
                i + 1,
                win.style,
                win.width,
                win.height,
                'Standard Configuration'
            ])
        };

        doc.table(table, {
            x: 50,
            prepareHeader: () => doc.fontSize(9).fillColor('#023047'),
            prepareRow: (row, indexColumn, indexRow, rectRow) => {
                doc.fontSize(8).fillColor('#333333');
                if (indexRow % 2 === 1) doc.addBackground(rectRow, '#F8F9FA', 1);
            },
            padding: 8, // IMPROVED: Increased padding
            columnSpacing: 5,
            divider: {
                header: { disabled: false, width: 1, opacity: 1, color: '#023047' },
                horizontal: { disabled: false, width: 0.5, opacity: 0.3 }
            }
        });

        doc.moveDown(2); // IMPROVED: Added more space
    });
};

const generateProductionSheets = (doc, data, quote) => {
    doc.moveDown(2);

    const titleY = doc.y;
    doc.fillColor('#023047').fontSize(16).text('Production Work Order', 50, titleY);
    doc.rect(50, titleY + 20, 180, 2).fill('#219ebc'); // IMPROVED: Better spacing
    doc.moveDown(1.5); // IMPROVED: Added space

    doc.fillColor('#444444').fontSize(10)
        .text('Detailed production instructions including cutting lists and glass schedules.',
            50, doc.y, { align: 'left', width: doc.page.width - 100 });
    doc.moveDown(1.5); // IMPROVED: Added space

    const timberDeduction = data.existingFrame === 'timber' ? 60 : 0;

    data.rooms.forEach(room => {
        room.windows.forEach((win, wIdx) => {
            if (doc.y > doc.page.height - 250) { // IMPROVED: Adjusted page break logic
                addNewPage(doc, quote);
            }

            // Window header
            doc.roundedRect(50, doc.y, doc.page.width - 100, 30, 5).fill('#023047');
            doc.fillColor('#FFFFFF').fontSize(11)
                .text(`Room: ${room.name} | Window ${wIdx + 1}`, 65, doc.y + 8);
            doc.moveDown(1.5); // IMPROVED: Added space

            const cutWidth = win.width - timberDeduction;
            const cutHeight = win.height - timberDeduction;
            const rowsStr = win.style.split('/');
            const numRows = rowsStr.length;

            // Cutting List
            const cuttingRows = [
                ['Head / Sill', `${cutWidth} mm`, 2],
                ['Jambs', `${cutHeight} mm`, 2]
            ];

            if (numRows > 1) cuttingRows.push(['Transoms', `${cutWidth} mm`, numRows - 1]);

            rowsStr.forEach((row, rIdx) => {
                if (row.split('-').length > 1) {
                    cuttingRows.push([
                        `Mullions (Row ${rIdx + 1})`,
                        `${(cutHeight / numRows).toFixed(1)} mm`,
                        row.split('-').length - 1
                    ]);
                }
            });

            doc.fillColor('#023047').fontSize(10).text('1. Cutting List', 50, doc.y);
            doc.moveDown(0.5);

            doc.table({
                headers: ['Component', 'Cut Length', 'Qty'],
                rows: cuttingRows
            }, {
                x: 50,
                prepareHeader: () => doc.fontSize(9).fillColor('#023047'),
                prepareRow: (row, indexColumn, indexRow, rectRow) => {
                    doc.fontSize(8).fillColor('#333333');
                    if (indexRow % 2 === 1) doc.addBackground(rectRow, '#F8F9FA', 1);
                },
                padding: 5,
                columnSpacing: 5,
                divider: {
                    header: { disabled: false, width: 1, opacity: 1, color: '#023047' },
                    horizontal: { disabled: false, width: 0.5, opacity: 0.3 }
                }
            });

            doc.moveDown(1.5); // IMPROVED: Added more space

            // Glass Schedule
            const glassRows = [];
            rowsStr.forEach((row, rIdx) => {
                const panes = row.split('-');
                const paneWidth = cutWidth / panes.length;
                const paneHeight = cutHeight / numRows;
                panes.forEach((pane, pIdx) =>
                    glassRows.push([
                        `${rIdx + 1}-${pIdx + 1}`,
                        paneTypeMap[pane] || 'Unknown',
                        `${paneWidth.toFixed(1)} mm`,
                        `${paneHeight.toFixed(1)} mm`,
                        glazingTypeMap[data.glazingType] || 'N/A'
                    ])
                );
            });

            doc.fillColor('#023047').fontSize(10).text('2. Glass Schedule', 50, doc.y);
            doc.moveDown(0.5);

            doc.table({
                headers: ['Pane ID', 'Type', 'Width', 'Height', 'Glazing'],
                rows: glassRows
            }, {
                x: 50,
                prepareHeader: () => doc.fontSize(9).fillColor('#023047'),
                prepareRow: (row, indexColumn, indexRow, rectRow) => {
                    doc.fontSize(8).fillColor('#333333');
                    if (indexRow % 2 === 1) doc.addBackground(rectRow, '#F8F9FA', 1);
                },
                padding: 5,
                columnSpacing: 5,
                divider: {
                    header: { disabled: false, width: 1, opacity: 1, color: '#023047' },
                    horizontal: { disabled: false, width: 0.5, opacity: 0.3 }
                }
            });

            doc.moveDown(2); // IMPROVED: Added more space
        });
    });
};

const generatePriceBreakdown = (doc, calc, type, quote) => {
    const ESTIMATED_HEIGHT = 250; // IMPROVED: Adjusted height
    if (doc.y > doc.page.height - ESTIMATED_HEIGHT) {
        addNewPage(doc, quote);
    } else {
        doc.moveDown(2);
    }

    const titleY = doc.y;
    doc.fillColor('#023047').fontSize(16).text('Price Breakdown', 50, titleY);
    doc.rect(50, titleY + 20, 150, 2).fill('#219ebc'); // IMPROVED: Better spacing
    doc.moveDown(1.5); // IMPROVED: Added space

    doc.fillColor('#444444').fontSize(10)
        .text(type === 'sales' ? 'Internal cost breakdown for sales team.' : 'Estimated pricing for your project.',
            50, doc.y, { align: 'left', width: doc.page.width - 100 });
    doc.moveDown(1.5); // IMPROVED: Added space

    const table = {
        headers: [
            { label: 'Item', width: 350, renderer: null },
            { label: 'Cost', width: 150, align: 'right', renderer: null }
        ],
        rows: [
            ['Materials & Components Subtotal', `$${calc.subtotal.toFixed(2)}`],
            ['Waste & Profit Markup', `$${calc.markup.toFixed(2)}`],
            ['Factory Build Costs', `$${calc.factory.toFixed(2)}`],
            ['Total Base Price (ex. Installation)', `$${calc.base.toFixed(2)}`],
            ['Installation Cost', `$${calc.install.toFixed(2)}`],
        ]
    };

    doc.table(table, {
        x: 50,
        prepareHeader: () => doc.fontSize(10).fillColor('#023047'),
        prepareRow: (row, indexColumn, indexRow, rectRow) => {
            if (indexRow === 3 || indexRow === 4) {
                doc.fontSize(10).fillColor('#023047');
                doc.addBackground(rectRow, '#E8F4F8', 1);
            } else {
                doc.fontSize(9).fillColor('#333333');
                if (indexRow % 2 === 1) doc.addBackground(rectRow, '#F8F9FA', 1);
            }
        },
        padding: 8, // IMPROVED: Increased padding
        columnSpacing: 5,
        divider: {
            header: { disabled: false, width: 1, opacity: 1, color: '#023047' },
            horizontal: { disabled: false, width: 0.5, opacity: 0.3 }
        }
    });

    doc.moveDown(1.5); // IMPROVED: Added more space

    // Final Total in a highlighted box
    const boxY = doc.y;
    doc.roundedRect(50, boxY, doc.page.width - 100, 40, 10).fill('#023047');

    doc.fillColor('#FFFFFF').fontSize(12)
        .text('Final Estimated Total:', 70, boxY + 12); // IMPROVED: Vertical alignment

    doc.fillColor('#FFD700').fontSize(16)
        .text(`$${calc.final.toFixed(2)}`, 70, boxY + 12, { align: 'right', width: doc.page.width - 140 }); // IMPROVED: Vertical alignment
};

const generateTermsAndConditions = (doc, type, quote) => {
    const ESTIMATED_HEIGHT = 220; // IMPROVED: Adjusted height
    if (doc.y > doc.page.height - ESTIMATED_HEIGHT) {
        addNewPage(doc, quote);
    } else {
        doc.moveDown(2);
    }

    const titleY = doc.y;
    doc.fillColor('#023047').fontSize(14).text('Terms and Conditions', 50, titleY);
    doc.rect(50, titleY + 18, 180, 2).fill('#219ebc'); // IMPROVED: Better spacing
    doc.moveDown(1.5); // IMPROVED: Added space

    const terms = [
        'This quote is valid for 30 days from the date issued.',
        'Prices are subject to change based on material costs and availability.',
        'Installation is optional and can be adjusted based on project requirements.',
        'All work complies with local building codes and industry standards.',
        'Payment terms: 50% deposit upon acceptance, 50% upon project completion.',
        'Any changes to specifications may affect the quoted price.',
        'Lead times are estimated and subject to change based on production schedule.'
    ];

    doc.fillColor('#444444').fontSize(9);

    terms.forEach((term, idx) => {
        doc.text(`${idx + 1}. ${term}`, 50, doc.y, {
            width: doc.page.width - 100,
            align: 'justify'
        });
        doc.moveDown(0.5);
    });

    doc.moveDown(1.5); // IMPROVED: Added more space

    // Thank you message in a box
    const boxY = doc.y;
    const boxHeight = 35; // IMPROVED: Increased box height
    doc.roundedRect(50, boxY, doc.page.width - 100, boxHeight, 8).fillAndStroke('#F8F9FA', '#E0E0E0');

    // FIXED: Corrected vertical alignment for the "Thank you" message.
    doc.fillColor('#023047').fontSize(11)
        .text('Thank you for choosing CapLock Windows!', 0, boxY + (boxHeight - 11) / 2, { // Calculation for perfect centering
            align: 'center'
        });
};

// --- Internal Calculation Logic ---
function calculateInternal(body) {
    const { existingFrame, glazingType, installationCosts, rooms } = body;
    if (!rooms) return { subtotal: 0, markup: 0, factory: 0, base: 0, install: 0, final: 0 };

    const addInstallation = installationCosts === 'yes';
    const glazingMultiplier = pricingData.glazingMultipliers[glazingType] || 1.0;
    let subtotal = 0;
    let totalWindows = 0;

    rooms.forEach(room => {
        room.windows.forEach(win => {
            if (!win.height || !win.width || win.height <= 0 || win.width <= 0) return;
            totalWindows++;

            let height = win.height;
            let width = win.width;

            if (existingFrame === 'timber') {
                height -= 60;
                width -= 60;
            }

            if (height <= 0 || width <= 0) return;

            const rowsStr = win.style.split('/');
            const numRows = rowsStr.length;
            const rowHeight = height / numRows;
            let materialCost = 0;
            let verticalMullionLength = 0;

            materialCost += (width * pricingData.frameHeadCostPerMm) +
                (width * pricingData.frameSillCostPerMm) +
                (2 * height * pricingData.frameJambCostPerMm);

            if (numRows > 1) materialCost += (numRows - 1) * width * pricingData.mullionCostPerMm;

            rowsStr.forEach(row => {
                const panes = row.split('-');
                const numPanesInRow = panes.length;

                if (numPanesInRow > 1) {
                    const mullionLength = (numPanesInRow - 1) * rowHeight;
                    materialCost += mullionLength * pricingData.mullionCostPerMm;
                    verticalMullionLength += mullionLength;
                }

                panes.forEach(pane => {
                    materialCost += (rowHeight * (width / numPanesInRow)) *
                        pricingData.glassCostPerSqMm * glazingMultiplier;

                    const paneType = paneTypeMap[pane];
                    if (paneType && pricingData.fixedCosts[paneType]) {
                        materialCost += pricingData.fixedCosts[paneType];
                    }
                });
            });

            const totalExtrusionLength = (2 * width) + (2 * height) +
                ((numRows - 1) * width) + verticalMullionLength;
            materialCost += totalExtrusionLength * pricingData.powderCoatingPerMm;

            subtotal += materialCost;
        });
    });

    const markup = subtotal * (pricingData.wasteAndProfitMarkup - 1);
    const factory = totalWindows * pricingData.factoryBuildCostPerWindow;
    const base = subtotal + markup + factory;
    const install = addInstallation ? totalWindows * pricingData.installationCostPerWindow : 0;
    const final = base + install;

    return { subtotal, markup, factory, base, install, final };
}

// --- Start Server ---
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log('Ensure you have `caplock-logo.png` in the root directory.');
    console.log('Fonts directory is optional - will use system fonts if not available.');
});