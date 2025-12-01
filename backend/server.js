const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors'); // Menggunakan cors() tanpa konfigurasi adalah yang paling selamat untuk API umum
const admin = require('firebase-admin');

const app = express();
const port = process.env.PORT || 3001; 

// Konfigurasi Middleware
app.use(bodyParser.json());
// ✅ Menggunakan CORS lalai (membenarkan semua origin, termasuk GitHub Pages anda)
app.use(cors()); 

// ===============================================
// FIREBASE CONFIGURATION (BASE64 DECODING DAN URL RTDB)
// ===============================================

// Ambil kunci BASE64 yang MENGANDUNGI KESELURUHAN JSON file, disimpan sebagai FIREBASE_PRIVATE_KEY
const serviceAccountBase64 = process.env.FIREBASE_PRIVATE_KEY;
// URL PANGKALAN DATA (WAJIB DITETAPKAN SECARA MANUAL)
const FIREBASE_DATABASE_URL = 'https://istem-garaj-default-rtdb.asia-southeast1.firebasedatabase.app'; 

let serviceAccount = null;

if (serviceAccountBase64) {
    try {
        // Nyahkod dari Base64 kembali ke rentetan JSON
        const jsonString = Buffer.from(serviceAccountBase64, 'base64').toString('utf8');
        // Parse rentetan JSON kepada objek JavaScript
        serviceAccount = JSON.parse(jsonString);

    } catch (e) {
        console.error("RALAT: Gagal menyahkod Base64 atau parse JSON:", e.message);
        // Hentikan proses jika Base64 tidak boleh dibaca atau JSON rosak
        process.exit(1); 
    }
}

// Semak konfigurasi asas sebelum initialize Firebase
if (!serviceAccount || !serviceAccount.project_id || !serviceAccount.private_key) {
    console.error("RALAT KONFIGURASI: Pemboleh ubah persekitaran Firebase tidak lengkap atau tidak sah.");
    process.exit(1); 
}

try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: FIREBASE_DATABASE_URL // Penambahan ini menyelesaikan ralat URL
    });
} catch (error) {
    console.error("RALAT FIREBASE INITIATION:", error.message);
    process.exit(1);
}


const db = admin.database();
const bookingsRef = db.ref('bookings');
const usersRef = db.ref('users');

const totalGaraj = 8;

// ===============================================
// HELPER FUNCTIONS
// ===============================================

function formatDateDMY(date){
  const d = String(date.getDate()).padStart(2,'0');
  const m = String(date.getMonth()+1).padStart(2,'0');
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}

function parseDMY(dateStr){
  if (!dateStr) throw new Error('Empty date string');
  
  // 1. Cuba parse format DD/MM/YYYY
  const parts = dateStr.split('/');
  if (parts.length === 3) {
      const [d,m,y] = parts.map(p => parseInt(p));
      if (isNaN(d) || isNaN(m) || isNaN(y)) throw new Error(`Invalid date numbers in DD/MM/YYYY: ${dateStr}`);
      return new Date(y, m - 1, d);	
  }

  // 2. Cuba parse format YYYY-MM-DD
  if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
      const [y, m, d] = dateStr.split('-').map(p => parseInt(p));
      return new Date(y, m - 1, d);
  }

  throw new Error(`Invalid date format: ${dateStr}`);
}

function snapshotToArray(snapshot) {
	const arr = [];
	snapshot.forEach(childSnapshot => {
		arr.push({ id: childSnapshot.key, ...childSnapshot.val() });	
	});
	return arr;
}

function getMonthName(dateStr) {
	try {
		const date = parseDMY(dateStr);
		return date.toLocaleString('ms-MY', { month: 'long', year: 'numeric' });
	} catch (e) {
		return 'Invalid Date';
	}
}

async function getAvailableGarage(startMonthStr, endMonthStr) {
        const startDate = parseDMY(startMonthStr);
        const endDate = parseDMY(endMonthStr);
	
	const checkStart = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0);
	const checkEnd = new Date(endDate.getFullYear(), endDate.getMonth() + 1, 0);

	const snapshot = await bookingsRef.once('value');
	const allBookings = snapshotToArray(snapshot).filter(b => b.status === 'Approved');
	
	const availableGaraj = Array.from({length: totalGaraj}, (_, i) => i + 1);
	const occupiedGaraj = new Set();
	
	allBookings.forEach(b => {
		if (!b.garaj || !b.startMonth || !b.endMonth) return;
		
		try {
			const bStart = parseDMY(b.startMonth);
			const bEnd = parseDMY(b.endMonth);
			
			const bCheckStart = new Date(bStart.getFullYear(), bStart.getMonth() + 1, 0);	
			const bCheckEnd = new Date(bEnd.getFullYear(), bEnd.getMonth() + 1, 0);

			if (checkStart <= bCheckEnd && checkEnd >= bCheckStart) {
				occupiedGaraj.add(b.garaj);
			}
		} catch (e) {
			console.error('Error parsing date for booking:', b.id, e);
		}
	});

	return availableGaraj.filter(g => !occupiedGaraj.has(g));
}

// Memastikan sambungan Firebase boleh dicapai sebelum memulakan server
async function verifyDatabaseConnection(timeoutMs = 5000) {
        const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Firebase Realtime Database tidak memberi respons tepat pada masanya.')),
                        timeoutMs)
        );

        const connectionPromise = db.ref('.info/connected').once('value').then((snapshot) => {
                if (!snapshot.exists()) {
                        throw new Error('Node .info/connected tidak ditemui. Semak konfigurasi databaseURL.');
                }
                return snapshot.val();
        });

        return Promise.race([timeoutPromise, connectionPromise]).then((isConnected) => {
                if (!isConnected) {
                        throw new Error('Tidak dapat mengesahkan sambungan Firebase.');
                }
        });
}

// ===============================================
// ✅ ROOT/HEALTH CHECK ENDPOINT 
// ===============================================
app.get('/', (req, res) => {
    res.status(200).json({
        message: "Selamat datang ke API Pengurusan Garaj! API ini berfungsi dengan baik.",
        endpoints: ["/login", "/bookings", "/analytics", "/garaj-status", "/export/csv"]
    });
});

// ===============================================
// ✅ ANALYTICS ENDPOINT	
// ===============================================
app.get('/analytics', async (req, res) => {
	try {
		const snapshot = await bookingsRef.once('value');
		const bookings = snapshotToArray(snapshot);
		
		const stats = {
			totalBookings: bookings.length,
			approved: bookings.filter(b => b.status === 'Approved').length,
			pending: bookings.filter(b => b.status === 'Pending').length,
			rejected: bookings.filter(b => b.status === 'Rejected').length,
			cancelled: bookings.filter(b => b.status === 'Cancelled').length
		};
		
		const now = new Date();
		const monthlyUsage = [];	
		
		for (let i = 5; i >= 0; i--) {
			const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
			
			const monthBookings = bookings.filter(b => {
				if (!b.startMonth) return false;
				try {
					const bookingDate = parseDMY(b.startMonth);
					return bookingDate.getMonth() === date.getMonth() &&	
						   bookingDate.getFullYear() === date.getFullYear();
				} catch(e) {
					return false;
				}
			});
			
			const totalMonthCount = monthBookings.length;
			
			monthlyUsage.push({
				month: getMonthName(formatDateDMY(date)),	
				count: totalMonthCount
			});
		}
		
		res.json({
			...stats,
			monthlyUsage: monthlyUsage	
		});
		
	} catch(error) {
		console.error('Analytics error:', error);
		res.status(500).json({
			totalBookings: 0, approved: 0, pending: 0, rejected: 0, cancelled: 0, monthlyUsage: [],
			message: 'Gagal memuatkan data analytics.'
		});
	}
});

// ===============================================
// ✅ LOGIN ENDPOINT	
// ===============================================
app.post('/login', async (req, res) => {
	const { username, password } = req.body;
	
	if (!username || !password) {
		return res.json({ success: false, message: 'Sila isi semua ruangan!' });
	}
	
	try {
		const snapshot = await usersRef.once('value');
		const users = snapshotToArray(snapshot);
		const user = users.find(u => u.username === username && u.password === password);
		
		if (user) {
			return res.json({	
				success: true,	
				message: 'Login Berjaya!',	
				username: user.username,	
				role: user.role,
				studentID: user.studentID	
			});
		} else {
			return res.json({ success: false, message: 'Username atau Password salah!' });
		}
	} catch (error) {
		console.error('Login error:', error);
		return res.status(500).json({ success: false, message: 'Ralat Server. Sila cuba lagi.' });
	}
});


// ===============================================
// ✅ GARAJ STATUS ENDPOINT	
// ===============================================
app.get('/garaj-status', async (req, res) => {
	try {
		const available = await getAvailableGarage(formatDateDMY(new Date()), formatDateDMY(new Date()));
		const statusList = [];
		
		for (let i = 1; i <= totalGaraj; i++) {
			statusList.push({
				garaj: i,
				occupied: !available.includes(i)
			});
		}
		
		res.json(statusList);
	} catch (error) {
		console.error('Garaj status error:', error);
		res.status(500).json([]);
	}
});


// ===============================================
// ✅ BOOKING ENDPOINTS	
// ===============================================

// GET /bookings (Admin: Filter & Search)
app.get('/bookings', async (req, res) => {
	const { search, status } = req.query;
	try {
		const snapshot = await bookingsRef.once('value');
		let bookings = snapshotToArray(snapshot);
		
		if (status) {
			bookings = bookings.filter(b => b.status === status);
		}
		
		if (search) {
			const searchTerm = search.toLowerCase();
			bookings = bookings.filter(b =>	
				b.studentName.toLowerCase().includes(searchTerm) ||
				b.studentID.toLowerCase().includes(searchTerm)
			);
		}
		
		res.json(bookings);
	} catch (error) {
		console.error('Bookings list error:', error);
		res.status(500).json([]);
	}
});

// GET /user-bookings (User: Filter by studentID)
app.get('/user-bookings', async (req, res) => {
	const { studentID } = req.query;
	if (!studentID) {
		return res.status(400).json({ success: false, message: 'Student ID diperlukan.' });
	}

	try {
		const snapshot = await bookingsRef.once('value');
		let bookings = snapshotToArray(snapshot);
		
		bookings = bookings.filter(b => b.studentID === studentID);
		
		res.json(bookings);
	} catch (error) {
		console.error('User bookings list error:', error);
		res.status(500).json([]);
	}
});

// ✅ Laluan untuk user.html mendapatkan senarai tempahan
// GET /bookings/history/:username	
app.get('/bookings/history/:username', async (req, res) => {
	const { username } = req.params;
	try {
		const snapshot = await bookingsRef.once('value');
		let bookings = snapshotToArray(snapshot);
		
		bookings = bookings.filter(b => b.username === username);	
		
		res.json(bookings);
	} catch (error) {
		console.error('User history error:', error);
		res.status(500).json([]);
	}
});


// POST /bookings (User: Create booking)
app.post('/bookings', async (req, res) => {
        const { username, studentName, studentID, startMonth, duration, garaj: preferredGaraj } = req.body;

        if (!studentName || !studentID || !startMonth || !duration || !username) {
                return res.status(400).json({ success: false, message: 'Sila isi semua ruangan yang wajib.' });
        }

        const durationMonths = parseInt(duration);

        try {
                // Asumsi startMonth dalam format YYYY-MM
                const startDate = parseDMY(`01/${startMonth.substring(5, 7)}/${startMonth.substring(0, 4)}`);

                // Menentukan endMonth: Tambah tempoh (durationMonths) ke bulan mula (startDate.getMonth()),
                // dan dapatkan hari terakhir bulan tersebut (hari 0 bulan seterusnya)
                const endDate = new Date(startDate.getFullYear(), startDate.getMonth() + durationMonths, 0);

                const bookingData = {
                        username,
                        studentName,
                        studentID,
                        startMonth: formatDateDMY(startDate),
                        endMonth: formatDateDMY(endDate),
                        duration: durationMonths,
                        garaj: null,
                        status: 'Pending',
                        message: 'Menunggu kelulusan Admin'
                };

                const available = await getAvailableGarage(bookingData.startMonth, bookingData.endMonth);

                if (available.length > 0) {
                        const preferred = preferredGaraj ? parseInt(preferredGaraj) : null;

                        if (preferred) {
                                if (!available.includes(preferred)) {
                                        return res.status(400).json({
                                                success: false,
                                                message: `Garaj ${preferred} tidak tersedia untuk tempoh ini. Sila pilih garaj lain.`,
                                                availableGaraj: available
                                        });
                                }
                                bookingData.garaj = preferred;
                                bookingData.status = 'Approved';
                                bookingData.message = `Garaj ${preferred} ditetapkan mengikut pilihan pengguna.`;
                        } else {
                                bookingData.garaj = available[0];
                                bookingData.status = 'Approved';
                                bookingData.message = `Garaj ${available[0]} ditetapkan secara automatik.`;
                        }
                } else {
                        bookingData.message = 'Tiada garaj tersedia dalam tempoh ini. Dalam barisan (Queue).';
                }

                const newBookingRef = bookingsRef.push(bookingData);
                await newBookingRef.update({ id: newBookingRef.key });

                if (bookingData.status === 'Approved') {
                        return res.status(201).json({ success: true, message: `Tempahan diterima dan Garaj ${bookingData.garaj} ditetapkan.` });
                } else {
                        return res.status(201).json({ success: true, message: 'Tempahan berjaya dibuat. Menunggu kelulusan Admin (dalam barisan).' });
                }
        } catch (error) {
                console.error('Booking creation error:', error);
                return res.status(500).json({ success: false, message: 'Ralat Server. Sila cuba lagi.' });
        }
});

// POST /bookings/:id/garaj (Admin: Assign garage)
app.post('/bookings/:id/garaj', async (req, res) => {
	const { id } = req.params;
	const { garaj } = req.body;

	if (!garaj) {
		return res.status(400).json({ success: false, message: 'Nombor garaj diperlukan.' });
	}

	try {
		const snapshot = await bookingsRef.child(id).once('value');
		const booking = snapshot.val();

		if (!booking) {
			return res.status(404).json({ success: false, message: 'Tempahan tidak ditemui.' });
		}
		
		const available = await getAvailableGarage(booking.startMonth, booking.endMonth);
		
		if (!available.includes(parseInt(garaj))) {
			return res.status(400).json({ success: false, message: `Garaj ${garaj} telah ditempah dalam tempoh ${booking.startMonth} - ${booking.endMonth}.`, availableGaraj: available });
		}

		const updateData = {
			garaj: parseInt(garaj),
			status: 'Approved',
			message: `Garaj ${garaj} ditetapkan oleh Admin.`
		};

		await bookingsRef.child(id).update(updateData);
		return res.json({ success: true, message: `Garaj ${garaj} berjaya ditetapkan.` });

	} catch (error) {
		console.error('Assign garage error:', error);
		return res.status(500).json({ success: false, message: 'Ralat Server. Sila cuba lagi.' });
	}
});

// POST /bookings/:id/reject (Admin: Reject booking)
app.post('/bookings/:id/reject', async (req, res) => {
	const { id } = req.params;
	const { message } = req.body;
	
	try {
		const updateData = {
			status: 'Rejected',
			message: message || 'Ditolak oleh Admin tanpa sebab spesifik.'
		};
		await bookingsRef.child(id).update(updateData);
		return res.json({ success: true, message: `Tempahan ${id} berjaya ditolak.` });
	} catch (error) {
		console.error('Reject booking error:', error);
		return res.status(500).json({ success: false, message: 'Ralat Server. Sila cuba lagi.' });
	}
});

// POST /bookings/:id/cancel (User/Admin: Cancel booking)
app.post('/bookings/:id/cancel', async (req, res) => {
	const { id } = req.params;
	
	try {
		const updateData = {
			status: 'Cancelled',
			message: 'Dibatalkan oleh Pengguna/Admin.',
			garaj: null	
		};
		await bookingsRef.child(id).update(updateData);
		
		checkQueue();	
		
		return res.json({ success: true, message: `Tempahan ${id} berjaya dibatalkan. Garaj dibebaskan.` });
	} catch (error) {
		console.error('Cancel booking error:', error);
		return res.status(500).json({ success: false, message: 'Ralat Server. Sila cuba lagi.' });
	}
});

// POST /bookings/:id/extend (User/Admin: Extend booking)
app.post('/bookings/:id/extend', async (req, res) => {
	const { id } = req.params;
	const { extra } = req.body;	
	const extraMonths = parseInt(extra);

	if (isNaN(extraMonths) || extraMonths <= 0) {
		return res.status(400).json({ success: false, message: 'Bilangan bulan tambahan tidak sah.' });
	}
	
	try {
		const snapshot = await bookingsRef.child(id).once('value');
		const booking = snapshot.val();
		
		if (!booking || booking.status !== 'Approved' || !booking.garaj) {
			return res.status(400).json({ success: false, message: 'Hanya tempahan yang diluluskan dan ditetapkan garaj boleh dilanjutkan.' });
		}
		
		// Dapatkan tarikh tamat semasa
		const currentEndDate = parseDMY(booking.endMonth);
		
		// Tarikh mula semakan adalah bulan selepas tarikh tamat semasa
		const checkStartDate = new Date(currentEndDate.getFullYear(), currentEndDate.getMonth() + 1, 1);
		
		// Tarikh tamat baru adalah selepas tempoh lanjutan
		const newEndDate = new Date(checkStartDate.getFullYear(), checkStartDate.getMonth() + extraMonths, 0);	
		const newEndDateStr = formatDateDMY(newEndDate);
		
		// Semak ketersediaan garaj yang SAMA untuk tempoh lanjutan
		const allBookingsSnapshot = await bookingsRef.once('value');
		const allBookings = snapshotToArray(allBookingsSnapshot).filter(b => b.id !== id && b.status === 'Approved');
		
		const isOverlap = allBookings.some(b => {
			 if (!b.garaj || b.garaj !== booking.garaj) return false;
			 
			 try {
				// Tarikh tempahan sedia ada yang lain
				const bStart = parseDMY(b.startMonth);
				const bEnd = parseDMY(b.endMonth);
				
				// Tarikh semakan tempoh lanjutan
				const checkStart = parseDMY(formatDateDMY(checkStartDate)); // Bulan bermula semakan
				const checkEnd = parseDMY(newEndDateStr); // Bulan tamat baru

				// Dapatkan hari terakhir bulan untuk perbandingan yang adil
				const bCheckStart = new Date(bStart.getFullYear(), bStart.getMonth() + 1, 0);	
				const bCheckEnd = new Date(bEnd.getFullYear(), bEnd.getMonth() + 1, 0);
				const checkEndCompare = new Date(checkEnd.getFullYear(), checkEnd.getMonth() + 1, 0);
				
				// Semakan bertindih (overlap check)
				if (checkStart <= bCheckEnd && checkEndCompare >= bCheckStart) {
					return true;
				}
				return false;
			 } catch (e) {
				 console.error('Error in overlap check during extend:', e);
				 return false;
			 }
		});

		if (isOverlap) {
			return res.status(400).json({ success: false, message: `Garaj ${booking.garaj} telah ditempah oleh orang lain dalam tempoh lanjutan ini.` });
		}

		const newDuration = booking.duration + extraMonths;
		const updateData = {
			endMonth: newEndDateStr,
			duration: newDuration,
			message: `Tempahan dilanjutkan sebanyak ${extraMonths} bulan. Tamat pada ${newEndDateStr}.`
		};

		await bookingsRef.child(id).update(updateData);
		return res.json({ success: true, message: `Tempahan berjaya dilanjutkan hingga ${newEndDateStr}!` });

	} catch (error) {
		console.error('Extend booking error:', error);
		return res.status(500).json({ success: false, message: 'Ralat Server. Sila cuba lagi.' });
	}
});

// DELETE /bookings/:id (Admin: Delete booking)
app.delete('/bookings/:id', async (req, res) => {
	const { id } = req.params;
	try {
		await bookingsRef.child(id).remove();
		checkQueue();	
		return res.json({ success: true, message: `Tempahan ${id} berjaya dipadam.` });
	} catch (error) {
		console.error('Delete booking error:', error);
		return res.status(500).json({ success: false, message: 'Ralat Server. Sila cuba lagi.' });
	}
});


// ===============================================
// ✅ EXPORT CSV ENDPOINT	
// ===============================================
app.get('/export/csv', async (req, res) => {
	try {
		const snapshot = await bookingsRef.once('value');
		const bookings = snapshotToArray(snapshot);
		
		const headers = "ID Tempahan,Nama,No Matrik,Bulan Mula,Bulan Tamat,Tempoh,Garaj,Status,Mesej\n";
		const rows = bookings.map(b =>	
			`${b.id},"${b.studentName}",${b.studentID},${b.startMonth},${b.endMonth},${b.duration},${b.garaj || ''},${b.status},"${b.message ? b.message.replace(/"/g, '""').replace(/\n/g, ' ') : ''}"`
		).join("\n");
		
		const csv = headers + rows;
		res.setHeader('Content-disposition', 'attachment; filename=bookings.csv');
		res.set('Content-Type', 'text/csv');
		res.status(200).send(csv);
		
	} catch(error) {
		console.error('CSV export error:', error);
		res.status(500).send('Gagal mengeksport data CSV.');
	}
});


// ===============================================
// ✅ QUEUE CHECKER	
// ===============================================
async function checkQueue() {
	try {
		const snapshot = await bookingsRef.orderByChild('status').equalTo('Pending').once('value');
		let pendingBookings = snapshotToArray(snapshot);
		
		// Susun mengikut masa tempahan (atau ID) untuk FIFO (First In, First Out)
		pendingBookings.sort((a, b) => a.id.localeCompare(b.id));	
		
		for (const b of pendingBookings) {
			if (!b.startMonth || !b.endMonth) continue;
			
			const available = await getAvailableGarage(b.startMonth, b.endMonth);
			
			if(available.length > 0){
				const updateData = {
					garaj: available[0],	
					status: "Approved",
					message: `Garaj ${available[0]} berjaya ditetapkan dari queue (Auto)`
				};
				await bookingsRef.child(b.id).update(updateData);
			}	
		}
	} catch(error) {
		console.error("Ralat dalam checkQueue:", error);
	}
}
// Jalankan semakan queue setiap 30 saat untuk menangani queue secara automatik
setInterval(checkQueue, 30000);

// ===============================================
// ✅ GARAJ AVAILABILITY CHECK
// ===============================================
app.get('/garaj-available', async (req, res) => {
        const { startMonth, duration } = req.query;

        if (!startMonth || !duration) {
                return res.status(400).json({ success: false, message: 'startMonth dan duration diperlukan.' });
        }

        try {
                const durationMonths = parseInt(duration);
                if (isNaN(durationMonths) || durationMonths <= 0) {
                        return res.status(400).json({ success: false, message: 'duration mesti nombor bulan yang sah.' });
                }

                const startDate = parseDMY(`01/${startMonth.substring(5, 7)}/${startMonth.substring(0, 4)}`);
                const endDate = new Date(startDate.getFullYear(), startDate.getMonth() + durationMonths, 0);

                const available = await getAvailableGarage(formatDateDMY(startDate), formatDateDMY(endDate));
                return res.json({ success: true, available });
        } catch (error) {
                console.error('Garaj availability error:', error);
                return res.status(500).json({ success: false, message: 'Ralat pelayan semasa memeriksa garaj tersedia.' });
        }
});

// ===============================================
// START SERVER
// ===============================================
(async () => {
        try {
                await verifyDatabaseConnection();
                console.log('Firebase Realtime Database disahkan bersambung.');
        } catch (error) {
                console.error('Gagal mengesahkan sambungan Firebase:', error.message);
                process.exit(1);
        }

        app.listen(port, () => {
                console.log(`Server berjalan di port ${port}`);
        });
})();
