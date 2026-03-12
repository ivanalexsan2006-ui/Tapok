const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ========== НАСТРОЙКИ ==========
const JWT_SECRET = process.env.JWT_SECRET || 'tapok-super-secret-key-2025';
const APP_PASSWORD = process.env.APP_PASSWORD || '123456'; // Меняй здесь пароль
const PORT = process.env.PORT || 3000;

// ========== ПОДКЛЮЧЕНИЕ К БАЗЕ ДАННЫХ ==========
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/tapok',
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Создаем папки
['public', 'uploads', 'public/avatars'].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ========== СОЗДАНИЕ ТАБЛИЦ ==========
async function initDb() {
    try {
        // Пользователи
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                name VARCHAR(100) NOT NULL,
                avatar TEXT,
                status VARCHAR(20) DEFAULT 'offline',
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Чаты
        await pool.query(`
            CREATE TABLE IF NOT EXISTS chats (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100),
                is_group BOOLEAN DEFAULT false,
                created_by INTEGER REFERENCES users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Участники чатов
        await pool.query(`
            CREATE TABLE IF NOT EXISTS chat_participants (
                chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (chat_id, user_id)
            )
        `);

        // Сообщения
        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                text TEXT,
                media_url TEXT,
                media_type VARCHAR(20),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Непрочитанные сообщения
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
        const ext = path.extname(file.originalname);
        cb(null, file.fieldname + '-' + unique + ext);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// Статика
app.use('/uploads', express.static('uploads'));
app.use('/avatars', express.static('public/avatars'));

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
    const { username, name, password } = req.body;
    
    // Проверяем пароль для всех
    if (password !== APP_PASSWORD) {
        return res.status(403).json({ error: 'Неверный пароль доступа' });
    }

    if (!username || !name) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }

    try {
        // Проверяем, есть ли уже такой пользователь
        const existing = await pool.query(
            'SELECT id FROM users WHERE username = $1',
            [username]
        );

        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Такой пользователь уже есть' });
        }

        let avatar = null;
        if (req.file) {
            avatar = `/avatars/${req.file.filename}`;
        }

        // Создаем пользователя
        const result = await pool.query(
            'INSERT INTO users (username, name, avatar, status) VALUES ($1, $2, $3, $4) RETURNING *',
            [username, name, avatar, 'online']
        );

        const user = result.rows[0];
        const token = jwt.sign(
            { userId: user.id, username: user.username },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                username: user.username,
                name: user.name,
                avatar: user.avatar
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ВХОД
app.post('/api/login', async (req, res) => {
    const { username } = req.body;

    if (!username) {
        return res.status(400).json({ error: 'Введите имя пользователя' });
    }

    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE username = $1',
            [username]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }

        const user = result.rows[0];

        // Обновляем статус
        await pool.query(
            'UPDATE users SET status = $1, last_seen = CURRENT_TIMESTAMP WHERE id = $2',
            ['online', user.id]
        );

        const token = jwt.sign(
            { userId: user.id, username: user.username },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                username: user.username,
                name: user.name,
                avatar: user.avatar
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ПОЛУЧИТЬ ИНФО О СЕБЕ
app.get('/api/user/me', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, username, name, avatar, status, last_seen FROM users WHERE id = $1',
            [req.user.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ПОИСК ПОЛЬЗОВАТЕЛЕЙ
app.get('/api/users/search', authenticateToken, async (req, res) => {
    const { query } = req.query;
    
    if (!query || query.length < 1) return res.json([]);

    try {
        const result = await pool.query(
            'SELECT id, username, name, avatar, status FROM users WHERE (username ILIKE $1 OR name ILIKE $1) AND id != $2 LIMIT 20',
            [`%${query}%`, req.user.userId]
        );

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

        // Создаем чат
        const chatResult = await client.query(
            'INSERT INTO chats (name, is_group, created_by) VALUES ($1, $2, $3) RETURNING id',
            [name || null, isGroup || false, req.user.userId]
        );

        const chatId = chatResult.rows[0].id;

        // Добавляем участников
        for (const userId of allParticipants) {
            await client.query(
                'INSERT INTO chat_participants (chat_id, user_id) VALUES ($1, $2)',
                [chatId, userId]
            );
        }

        await client.query('COMMIT');

        res.json({ 
            id: chatId, 
            name, 
            isGroup: !!isGroup,
            participants: allParticipants 
        });

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

        // Для каждого чата получаем участников
        for (let chat of chats) {
            const participants = await pool.query(`
                SELECT u.id, u.username, u.name, u.avatar, u.status
                FROM users u
                JOIN chat_participants cp ON u.id = cp.user_id
                WHERE cp.chat_id = $1
            `, [chat.id]);

            chat.participants = participants.rows;
        }

        res.json(chats);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка получения чатов' });
    }
});

// ПОЛУЧИТЬ СООБЩЕНИЯ
app.get('/api/chats/:chatId/messages', authenticateToken, async (req, res) => {
    const { chatId } = req.params;
    const { limit = 50 } = req.query;

    try {
        // Проверяем доступ
        const access = await pool.query(
            'SELECT * FROM chat_participants WHERE chat_id = $1 AND user_id = $2',
            [chatId, req.user.userId]
        );

        if (access.rows.length === 0) {
            return res.status(403).json({ error: 'Нет доступа к чату' });
        }

        const result = await pool.query(`
            SELECT m.*, u.name as user_name, u.username, u.avatar
            FROM messages m
            JOIN users u ON m.user_id = u.id
            WHERE m.chat_id = $1
            ORDER BY m.created_at DESC
            LIMIT $2
        `, [chatId, limit]);

        // Отмечаем как прочитанные
        await pool.query(
            'DELETE FROM unread_messages WHERE chat_id = $1 AND user_id = $2',
            [chatId, req.user.userId]
        );

        res.json(result.rows.reverse());

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка получения сообщений' });
    }
});

// ОТПРАВИТЬ СООБЩЕНИЕ
app.post('/api/chats/:chatId/messages', authenticateToken, upload.fields([
    { name: 'photo', maxCount: 1 },
    { name: 'video', maxCount: 1 }
]), async (req, res) => {
    const { chatId } = req.params;
    const { text } = req.body;
    const files = req.files;

    let mediaUrl = null;
    let mediaType = null;

    if (files?.photo) {
        mediaUrl = `/uploads/${files.photo[0].filename}`;
        mediaType = 'photo';
    } else if (files?.video) {
        mediaUrl = `/uploads/${files.video[0].filename}`;
        mediaType = 'video';
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Сохраняем сообщение
        const messageResult = await client.query(
            `INSERT INTO messages (chat_id, user_id, text, media_url, media_type)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [chatId, req.user.userId, text, mediaUrl, mediaType]
        );

        const message = messageResult.rows[0];

        // Получаем всех участников чата
        const participants = await client.query(
            'SELECT user_id FROM chat_participants WHERE chat_id = $1 AND user_id != $2',
            [chatId, req.user.userId]
        );

        // Добавляем непрочитанные
        for (const p of participants.rows) {
            await client.query(
                'INSERT INTO unread_messages (user_id, chat_id, message_id) VALUES ($1, $2, $3)',
                [p.user_id, chatId, message.id]
            );
        }

        // Получаем полное сообщение с данными пользователя
        const fullMessage = await client.query(`
            SELECT m.*, u.name as user_name, u.username, u.avatar
            FROM messages m
            JOIN users u ON m.user_id = u.id
            WHERE m.id = $1
        `, [message.id]);

        await client.query('COMMIT');

        // Рассылаем через WebSocket
        const wsMessage = JSON.stringify({
            type: 'new_message',
            chatId: parseInt(chatId),
            message: fullMessage.rows[0]
        });

        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.userId) {
                client.send(wsMessage);
            }
        });

        res.json(fullMessage.rows[0]);

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Ошибка отправки сообщения' });
    } finally {
        client.release();
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
        }
    });
});

// ========== ЗАПУСК ==========
server.listen(PORT, () => {
    console.log(`\n🚀 TAPOK MESSENGER ЗАПУЩЕН!`);
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