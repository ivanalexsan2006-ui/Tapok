const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const webpush = require('web-push');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ========== НАСТРОЙКИ ==========
const JWT_SECRET = process.env.JWT_SECRET || 'tapok-super-secret-key-2025';
const APP_PASSWORD = process.env.APP_PASSWORD || '123456Tapok';
const PORT = process.env.PORT || 3000;

// VAPID keys для push-уведомлений
const vapidKeys = {
    publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
    privateKey: 'UUxI4O8-FbRouAevSmBQ6o18hgE4nSG3qwvJTfKc-ls'
};

webpush.setVapidDetails(
    'mailto:tapok@app.com',
    vapidKeys.publicKey,
    vapidKeys.privateKey
);

// ========== ПОДКЛЮЧЕНИЕ К БАЗЕ ==========
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Middleware для Service Worker (важно для iOS)
app.use((req, res, next) => {
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    next();
});

// Создаем папки
['public', 'uploads', 'public/icons', 'public/avatars'].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ========== СОЗДАНИЕ ТАБЛИЦ ==========
async function initDb() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                phone VARCHAR(50) UNIQUE NOT NULL,
                name VARCHAR(100) NOT NULL,
                avatar TEXT,
                status VARCHAR(20) DEFAULT 'offline',
                push_subscription JSONB,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS chats (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100),
                is_group BOOLEAN DEFAULT false,
                created_by INTEGER REFERENCES users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS chat_participants (
                chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                is_admin BOOLEAN DEFAULT false,
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (chat_id, user_id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                text TEXT,
                media_url TEXT,
                media_type VARCHAR(20),
                voice_url TEXT,
                voice_duration INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS unread_messages (
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
                message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, chat_id, message_id)
            )
        `);

        console.log('✅ База данных готова');
    } catch (err) {
        console.error('❌ Ошибка создания таблиц:', err);
    }
}

initDb();

// ========== ЗАГРУЗКА ФАЙЛОВ ==========
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (file.fieldname === 'avatar') {
            cb(null, 'public/avatars/');
        } else {
            cb(null, 'uploads/');
        }
    },
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname) || 
                   (file.mimetype === 'audio/mp4' ? '.m4a' : 
                    file.mimetype === 'audio/webm' ? '.webm' : 
                    path.extname(file.originalname));
        cb(null, file.fieldname + '-' + unique + ext);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { 
        fileSize: 100 * 1024 * 1024,
        files: 10
    },
    fileFilter: (req, file, cb) => {
        if (file.fieldname === 'voice') {
            if (file.mimetype === 'audio/mp4' || 
                file.mimetype === 'audio/webm' || 
                file.mimetype === 'audio/ogg' ||
                file.mimetype === 'audio/mpeg') {
                cb(null, true);
            } else {
                cb(new Error('Неподдерживаемый формат аудио'));
            }
        } else {
            cb(null, true);
        }
    }
});

// Статика
app.use('/uploads', express.static('uploads'));
app.use('/avatars', express.static('public/avatars'));

// Главные страницы
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

app.get('/chats.html', (req, res) => {
    res.sendFile(__dirname + '/public/chats.html');
});

app.get('/chat.html', (req, res) => {
    res.sendFile(__dirname + '/public/chat.html');
});

// ========== MIDDLEWARE ==========
async function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'Требуется авторизация' });

    try {
        const user = jwt.verify(token, JWT_SECRET);
        req.user = user;
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Недействительный токен' });
    }
}

// ========== API ==========

// РЕГИСТРАЦИЯ
app.post('/api/register', upload.single('avatar'), async (req, res) => {
    const { phone, name, password } = req.body;
    
    if (password !== APP_PASSWORD) {
        return res.status(403).json({ error: 'Неверный пароль доступа' });
    }

    if (!phone || !name) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }

    try {
        const existing = await pool.query(
            'SELECT id FROM users WHERE phone = $1',
            [phone]
        );

        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Такой номер уже зарегистрирован' });
        }

        let avatar = null;
        if (req.file) {
            avatar = `/avatars/${req.file.filename}`;
        }

        const result = await pool.query(
            'INSERT INTO users (phone, name, avatar, status) VALUES ($1, $2, $3, $4) RETURNING id, phone, name, avatar',
            [phone, name, avatar, 'online']
        );

        const user = result.rows[0];
        const token = jwt.sign(
            { userId: user.id, phone: user.phone },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.json({
            success: true,
            token,
            user
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ВХОД
app.post('/api/login', async (req, res) => {
    const { phone } = req.body;

    if (!phone) {
        return res.status(400).json({ error: 'Введите номер телефона' });
    }

    try {
        const result = await pool.query(
            'SELECT id, phone, name, avatar FROM users WHERE phone = $1',
            [phone]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }

        const user = result.rows[0];

        await pool.query(
            'UPDATE users SET status = $1, last_seen = CURRENT_TIMESTAMP WHERE id = $2',
            ['online', user.id]
        );

        const token = jwt.sign(
            { userId: user.id, phone: user.phone },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.json({
            success: true,
            token,
            user
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ПОИСК ПОЛЬЗОВАТЕЛЕЙ
app.get('/api/users/search', authenticateToken, async (req, res) => {
    const { query } = req.query;
    
    try {
        let result;
        if (query && query.length > 0) {
            result = await pool.query(
                'SELECT id, phone, name, avatar, status FROM users WHERE (phone ILIKE $1 OR name ILIKE $1) AND id != $2 LIMIT 20',
                [`%${query}%`, req.user.userId]
            );
        } else {
            result = await pool.query(
                'SELECT id, phone, name, avatar, status FROM users WHERE id != $1 ORDER BY name LIMIT 50',
                [req.user.userId]
            );
        }
        
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка поиска' });
    }
});

// СОЗДАТЬ ЧАТ
app.post('/api/chats', authenticateToken, async (req, res) => {
    const { name, isGroup, participants } = req.body;
    
    if (!participants || !participants.length) {
        return res.status(400).json({ error: 'Нужны участники' });
    }

    const allParticipants = [...new Set([req.user.userId, ...participants])];
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const chatResult = await client.query(
            'INSERT INTO chats (name, is_group, created_by) VALUES ($1, $2, $3) RETURNING id',
            [name || null, isGroup || false, req.user.userId]
        );

        const chatId = chatResult.rows[0].id;

        for (const userId of allParticipants) {
            await client.query(
                'INSERT INTO chat_participants (chat_id, user_id, is_admin) VALUES ($1, $2, $3)',
                [chatId, userId, userId === req.user.userId]
            );
        }

        await client.query('COMMIT');

        res.json({ id: chatId, name, isGroup: !!isGroup });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Ошибка создания чата' });
    } finally {
        client.release();
    }
});

// ПОЛУЧИТЬ ЧАТЫ
app.get('/api/chats', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                c.*,
                (
                    SELECT m.text FROM messages m 
                    WHERE m.chat_id = c.id 
                    ORDER BY m.created_at DESC LIMIT 1
                ) as last_message,
                (
                    SELECT m.media_type FROM messages m 
                    WHERE m.chat_id = c.id 
                    ORDER BY m.created_at DESC LIMIT 1
                ) as last_media_type,
                (
                    SELECT m.created_at FROM messages m 
                    WHERE m.chat_id = c.id 
                    ORDER BY m.created_at DESC LIMIT 1
                ) as last_message_time,
                (
                    SELECT COUNT(*) FROM unread_messages um 
                    WHERE um.chat_id = c.id AND um.user_id = $1
                ) as unread_count
            FROM chats c
            JOIN chat_participants cp ON c.id = cp.chat_id
            WHERE cp.user_id = $1
            GROUP BY c.id
            ORDER BY last_message_time DESC NULLS LAST
        `, [req.user.userId]);

        const chats = result.rows;

        for (let chat of chats) {
            const participants = await pool.query(`
                SELECT u.id, u.phone, u.name, u.avatar, u.status,
                       cp.is_admin
                FROM users u
                JOIN chat_participants cp ON u.id = cp.user_id
                WHERE cp.chat_id = $1
            `, [chat.id]);

            chat.participants = participants.rows;
        }

        res.json(chats);

    } catch (err) {
        console.error('Ошибка получения чатов:', err);
        res.status(500).json({ error: 'Ошибка получения чатов' });
    }
});

// ПОЛУЧИТЬ ЧАТ
app.get('/api/chats/:chatId', authenticateToken, async (req, res) => {
    const { chatId } = req.params;

    try {
        const chat = await pool.query(
            'SELECT * FROM chats WHERE id = $1',
            [chatId]
        );

        if (chat.rows.length === 0) {
            return res.status(404).json({ error: 'Чат не найден' });
        }

        const participants = await pool.query(`
            SELECT u.id, u.phone, u.name, u.avatar, u.status,
                   cp.is_admin
            FROM users u
            JOIN chat_participants cp ON u.id = cp.user_id
            WHERE cp.chat_id = $1
        `, [chatId]);

        const result = {
            ...chat.rows[0],
            participants: participants.rows
        };

        res.json(result);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка получения чата' });
    }
});

// УДАЛИТЬ ЧАТ
app.delete('/api/chats/:chatId', authenticateToken, async (req, res) => {
    const { chatId } = req.params;

    try {
        const participant = await pool.query(
            'SELECT * FROM chat_participants WHERE chat_id = $1 AND user_id = $2',
            [chatId, req.user.userId]
        );

        if (participant.rows.length === 0) {
            return res.status(403).json({ error: 'Нет доступа к чату' });
        }

        await pool.query('DELETE FROM chats WHERE id = $1', [chatId]);

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка удаления чата' });
    }
});

// ПОЛУЧИТЬ СООБЩЕНИЯ
app.get('/api/chats/:chatId/messages', authenticateToken, async (req, res) => {
    const { chatId } = req.params;
    const { limit = 50 } = req.query;

    try {
        const access = await pool.query(
            'SELECT * FROM chat_participants WHERE chat_id = $1 AND user_id = $2',
            [chatId, req.user.userId]
        );

        if (access.rows.length === 0) {
            return res.status(403).json({ error: 'Нет доступа к чату' });
        }

        const result = await pool.query(`
            SELECT m.*, u.name as user_name, u.phone, u.avatar
            FROM messages m
            JOIN users u ON m.user_id = u.id
            WHERE m.chat_id = $1
            ORDER BY m.created_at DESC
            LIMIT $2
        `, [chatId, limit]);

        await pool.query(
            'DELETE FROM unread_messages WHERE chat_id = $1 AND user_id = $2',
            [chatId, req.user.userId]
        );

        res.json(result.rows.reverse());

    } catch (err) {
        console.error('Ошибка получения сообщений:', err);
        res.status(500).json({ error: 'Ошибка получения сообщений' });
    }
});

// УДАЛИТЬ СООБЩЕНИЕ
app.delete('/api/messages/:messageId', authenticateToken, async (req, res) => {
    const { messageId } = req.params;

    try {
        const message = await pool.query(
            'SELECT user_id FROM messages WHERE id = $1',
            [messageId]
        );

        if (message.rows.length === 0) {
            return res.status(404).json({ error: 'Сообщение не найдено' });
        }

        if (message.rows[0].user_id !== req.user.userId) {
            return res.status(403).json({ error: 'Нельзя удалить чужое сообщение' });
        }

        await pool.query('DELETE FROM messages WHERE id = $1', [messageId]);

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка удаления сообщения' });
    }
});

// ОТПРАВКА СООБЩЕНИЙ
app.post('/api/chats/:chatId/messages', authenticateToken, upload.fields([
    { name: 'photos', maxCount: 10 },
    { name: 'videos', maxCount: 5 },
    { name: 'voice', maxCount: 1 }
]), async (req, res) => {
    const { chatId } = req.params;
    const { text, duration } = req.body;
    const files = req.files;

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const messages = [];

        if (text && text.trim()) {
            const textResult = await client.query(
                'INSERT INTO messages (chat_id, user_id, text) VALUES ($1, $2, $3) RETURNING *',
                [chatId, req.user.userId, text]
            );
            messages.push(textResult.rows[0]);
        }

        if (files?.photos) {
            for (const photo of files.photos) {
                const mediaUrl = `/uploads/${photo.filename}`;
                const photoResult = await client.query(
                    'INSERT INTO messages (chat_id, user_id, media_url, media_type) VALUES ($1, $2, $3, $4) RETURNING *',
                    [chatId, req.user.userId, mediaUrl, 'photo']
                );
                messages.push(photoResult.rows[0]);
            }
        }

        if (files?.videos) {
            for (const video of files.videos) {
                const mediaUrl = `/uploads/${video.filename}`;
                const videoResult = await client.query(
                    'INSERT INTO messages (chat_id, user_id, media_url, media_type) VALUES ($1, $2, $3, $4) RETURNING *',
                    [chatId, req.user.userId, mediaUrl, 'video']
                );
                messages.push(videoResult.rows[0]);
            }
        }

        if (files?.voice) {
            const voice = files.voice[0];
            const voiceUrl = `/uploads/${voice.filename}`;
            const voiceResult = await client.query(
                'INSERT INTO messages (chat_id, user_id, voice_url, voice_duration, media_type) VALUES ($1, $2, $3, $4, $5) RETURNING *',
                [chatId, req.user.userId, voiceUrl, duration || 0, 'voice']
            );
            messages.push(voiceResult.rows[0]);
        }

        const participants = await client.query(
            'SELECT user_id FROM chat_participants WHERE chat_id = $1 AND user_id != $2',
            [chatId, req.user.userId]
        );

        for (const msg of messages) {
            for (const p of participants.rows) {
                await client.query(
                    'INSERT INTO unread_messages (user_id, chat_id, message_id) VALUES ($1, $2, $3)',
                    [p.user_id, chatId, msg.id]
                );
            }
        }

        await client.query('COMMIT');

        const fullMessages = [];
        for (const msg of messages) {
            const fullMsg = await client.query(`
                SELECT m.*, u.name as user_name, u.phone, u.avatar
                FROM messages m
                JOIN users u ON m.user_id = u.id
                WHERE m.id = $1
            `, [msg.id]);
            fullMessages.push(fullMsg.rows[0]);
        }

        const wsMessage = JSON.stringify({
            type: 'new_message',
            chatId: parseInt(chatId),
            messages: fullMessages
        });

        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.userId) {
                const isParticipant = participants.rows.some(p => p.user_id === client.userId) || 
                                      client.userId === req.user.userId;
                if (isParticipant) {
                    client.send(wsMessage);
                }
            }
        });

        // PUSH-УВЕДОМЛЕНИЯ
        for (const p of participants.rows) {
            const userPush = await pool.query(
                'SELECT push_subscription, name FROM users WHERE id = $1',
                [p.user_id]
            );
            
            if (userPush.rows[0]?.push_subscription) {
                try {
                    let messageBody = '';
                    if (fullMessages[0]?.text) {
                        messageBody = `${fullMessages[0].user_name}: ${fullMessages[0].text.substring(0, 50)}`;
                    } else if (fullMessages[0]?.media_type === 'photo') {
                        messageBody = `${fullMessages[0].user_name} отправил(а) 📷 фото`;
                    } else if (fullMessages[0]?.media_type === 'video') {
                        messageBody = `${fullMessages[0].user_name} отправил(а) 🎥 видео`;
                    } else if (fullMessages[0]?.voice_url) {
                        messageBody = `${fullMessages[0].user_name} отправил(а) 🎤 голосовое`;
                    } else {
                        messageBody = `${fullMessages[0].user_name}: новое сообщение`;
                    }

                    const notificationPayload = {
                        title: '💬 Tapok',
                        body: messageBody,
                        icon: '/icons/icon-192.png',
                        badge: '/icons/icon-72.png',
                        vibrate: [200, 100, 200],
                        data: {
                            url: `/chat.html?id=${chatId}`,
                            chatId: chatId,
                            messageId: fullMessages[0]?.id,
                            timestamp: Date.now()
                        },
                        actions: [
                            {
                                action: 'open',
                                title: 'Открыть чат'
                            }
                        ],
                        dir: 'auto',
                        lang: 'ru',
                        renotify: true,
                        requireInteraction: true,
                        silent: false,
                        tag: `chat-${chatId}`,
                        timestamp: Date.now()
                    };
                    
                    await webpush.sendNotification(
                        userPush.rows[0].push_subscription,
                        JSON.stringify(notificationPayload)
                    );
                    
                    console.log(`✅ Push отправлен пользователю ${p.user_id}`);
                    
                } catch (e) {
                    console.error(`❌ Ошибка отправки push пользователю ${p.user_id}:`, e.message);
                    
                    if (e.statusCode === 410 || e.message.includes('expired')) {
                        await pool.query(
                            'UPDATE users SET push_subscription = NULL WHERE id = $1',
                            [p.user_id]
                        );
                    }
                }
            }
        }

        res.json(fullMessages);

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Ошибка отправки сообщения:', err);
        res.status(500).json({ error: 'Ошибка отправки сообщения' });
    } finally {
        client.release();
    }
});

// ПОДПИСКА НА PUSH
app.post('/api/push/subscribe', authenticateToken, async (req, res) => {
    const { subscription } = req.body;

    try {
        await pool.query(
            'UPDATE users SET push_subscription = $1 WHERE id = $2',
            [subscription, req.user.userId]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка подписки' });
    }
});

// Эндпоинт для проверки подписки
app.get('/api/push/status', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT push_subscription FROM users WHERE id = $1',
            [req.user.userId]
        );
        
        res.json({ 
            subscribed: !!result.rows[0]?.push_subscription
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========== WEB SOCKET ==========
wss.on('connection', (ws) => {
    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data);
            
            if (msg.type === 'auth') {
                try {
                    const user = jwt.verify(msg.token, JWT_SECRET);
                    ws.userId = user.userId;
                    await pool.query(
                        'UPDATE users SET status = $1, last_seen = CURRENT_TIMESTAMP WHERE id = $2',
                        ['online', user.userId]
                    );
                    
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN && client.userId !== ws.userId) {
                            client.send(JSON.stringify({
                                type: 'user_status',
                                userId: user.userId,
                                status: 'online'
                            }));
                        }
                    });
                } catch (err) {}
            }
            
            if (msg.type === 'typing') {
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN && client.userId !== ws.userId) {
                        client.send(JSON.stringify({
                            type: 'typing',
                            chatId: msg.chatId,
                            userId: ws.userId,
                            isTyping: msg.isTyping
                        }));
                    }
                });
            }
        } catch (e) {}
    });

    ws.on('close', async () => {
        if (ws.userId) {
            await pool.query(
                'UPDATE users SET status = $1, last_seen = CURRENT_TIMESTAMP WHERE id = $2',
                ['offline', ws.userId]
            );
            
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN && client.userId !== ws.userId) {
                    client.send(JSON.stringify({
                        type: 'user_status',
                        userId: ws.userId,
                        status: 'offline'
                    }));
                }
            });
        }
    });
});

// ========== ЗАПУСК ==========
server.listen(PORT, () => {
    console.log(`\n🚀 TAPOK MESSENGER 7.0 ЗАПУЩЕН!`);
    console.log(`📱 Пароль для всех: ${APP_PASSWORD}`);
    console.log(`💻 Локально: http://localhost:${PORT}`);
    console.log(`🌐 Для телефона: http://${getLocalIP()}:${PORT}\n`);
});

function getLocalIP() {
    const nets = require('os').networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) return net.address;
        }
    }
    return 'localhost';
}
