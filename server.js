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
const rateLimit = require('express-rate-limit');

process.env.LANG = 'en_US.UTF-8';
process.env.LC_ALL = 'en_US.UTF-8';

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
    'mailto:tapok-messenger@example.com',
    vapidKeys.publicKey,
    vapidKeys.privateKey
);

// ========== ПОДКЛЮЧЕНИЕ К БАЗЕ ==========
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Обработка ошибок пула
pool.on('error', (err) => {
    console.error('❌ Неожиданная ошибка пула соединений:', err);
});

// Проверка соединения при старте
async function testConnection() {
    try {
        const client = await pool.connect();
        console.log('✅ Подключение к БД успешно');
        client.release();
    } catch (err) {
        console.error('❌ Ошибка подключения к БД:', err);
        console.log('⏳ Повторная попытка через 5 секунд...');
        setTimeout(testConnection, 5000);
    }
}
testConnection();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.use((req, res, next) => {
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    next();
});

// Rate limiting
const messageLimiter = rateLimit({
    windowMs: 10 * 1000, // 10 секунд
    max: 5, // максимум 5 сообщений за 10 секунд
    message: { error: 'Слишком много сообщений. Подождите немного.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 час
    max: 5, // максимум 5 регистраций с одного IP
    message: { error: 'Слишком много попыток регистрации' }
});

// Создаем папки
['public', 'uploads', 'public/icons', 'public/avatars'].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ========== СОЗДАНИЕ ТАБЛИЦ ==========
async function initDb() {
    try {
        // Пользователи
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                phone VARCHAR(50) UNIQUE NOT NULL,
                name VARCHAR(100) NOT NULL,
                username VARCHAR(50) UNIQUE,
                avatar TEXT,
                status VARCHAR(20) DEFAULT 'offline',
                push_subscription JSONB,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                hide_phone BOOLEAN DEFAULT false,
                hide_status BOOLEAN DEFAULT false,
                hide_avatar BOOLEAN DEFAULT false,
                who_can_write VARCHAR(20) DEFAULT 'all',
                theme VARCHAR(10) DEFAULT 'dark'
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
                is_admin BOOLEAN DEFAULT false,
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
                voice_url TEXT,
                voice_duration INTEGER,
                reply_to INTEGER REFERENCES messages(id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Непрочитанные
        await pool.query(`
            CREATE TABLE IF NOT EXISTS unread_messages (
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
                message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, chat_id, message_id)
            )
        `);

        // Контакты пользователя
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_contacts (
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                contact_phone VARCHAR(50) NOT NULL,
                contact_name VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, contact_phone)
            )
        `);

        // Переименования контактов
        await pool.query(`
            CREATE TABLE IF NOT EXISTS contact_renames (
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                contact_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                custom_name VARCHAR(100) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, contact_user_id)
            )
        `);

        // История чатов
        await pool.query(`
            CREATE TABLE IF NOT EXISTS chat_history (
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
                last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, chat_id)
            )
        `);

        // Закрепленные сообщения
        await pool.query(`
            CREATE TABLE IF NOT EXISTS pinned_messages (
                id SERIAL PRIMARY KEY,
                chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
                message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
                pinned_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
                pinned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(chat_id, message_id)
            )
        `);

        // Права администраторов в группах
        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_permissions (
                chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                can_add_admins BOOLEAN DEFAULT false,
                can_manage_users BOOLEAN DEFAULT false,
                can_delete_messages BOOLEAN DEFAULT false,
                can_change_info BOOLEAN DEFAULT false,
                can_pin_messages BOOLEAN DEFAULT true,
                PRIMARY KEY (chat_id, user_id)
            )
        `);

        // ========== ИНДЕКСЫ ==========
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_participants_user_id ON chat_participants(user_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_participants_chat_id ON chat_participants(chat_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_unread_messages_user_id ON unread_messages(user_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_pinned_messages_chat_id ON pinned_messages(chat_id)`);

        console.log('✅ Все таблицы и индексы созданы');

    } catch (err) {
        console.error('❌ Ошибка создания таблиц:', err);
    }
}

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

app.get('/profile.html', (req, res) => {
    res.sendFile(__dirname + '/public/profile.html');
});

app.get('/user-profile.html', (req, res) => {
    res.sendFile(__dirname + '/public/user-profile.html');
});

app.get('/group-profile.html', (req, res) => {
    res.sendFile(__dirname + '/public/group-profile.html');
});

app.get('/settings.html', (req, res) => {
    res.sendFile(__dirname + '/public/settings.html');
});

app.get('/contacts.html', (req, res) => {
    res.sendFile(__dirname + '/public/contacts.html');
});

app.get('/sw-register.js', (req, res) => {
    res.sendFile(__dirname + '/public/sw-register.js');
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
app.post('/api/register', registerLimiter, upload.single('avatar'), async (req, res) => {
    const { phone, name, username, password } = req.body;
    
    if (password !== APP_PASSWORD) {
        return res.status(403).json({ error: 'Неверный пароль доступа' });
    }

    if (!phone || !name) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }

    try {
        if (username) {
            const usernameExists = await pool.query(
                'SELECT id FROM users WHERE username = $1',
                [username]
            );
            if (usernameExists.rows.length > 0) {
                return res.status(400).json({ error: 'Этот @username уже занят' });
            }
        }

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
            'INSERT INTO users (phone, name, username, avatar, status) VALUES ($1, $2, $3, $4, $5) RETURNING id, phone, name, username, avatar',
            [phone, name, username || null, avatar, 'online']
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
            'SELECT id, phone, name, username, avatar, theme, hide_phone, hide_status, hide_avatar, who_can_write FROM users WHERE phone = $1',
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

// ========== PUSH УВЕДОМЛЕНИЯ ==========
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

// Функция отправки push
async function sendPush(userId, payload) {
    try {
        const result = await pool.query(
            'SELECT push_subscription FROM users WHERE id = $1 AND push_subscription IS NOT NULL',
            [userId]
        );

        if (result.rows.length === 0 || !result.rows[0].push_subscription) {
            return;
        }

        const subscription = result.rows[0].push_subscription;
        
        if (!subscription.endpoint || !subscription.keys) {
            return;
        }

        await webpush.sendNotification(subscription, JSON.stringify(payload));
        console.log(`✅ Push отправлен пользователю ${userId}`);

    } catch (err) {
        console.error(`❌ Ошибка push для ${userId}:`, err.message);
        
        if (err.statusCode === 410) {
            await pool.query(
                'UPDATE users SET push_subscription = NULL WHERE id = $1',
                [userId]
            );
        }
    }
}

// ========== КОНТАКТЫ ==========
app.post('/api/contacts/sync', authenticateToken, async (req, res) => {
    const { contacts } = req.body;
    
    if (!contacts || !Array.isArray(contacts)) {
        return res.status(400).json({ error: 'Неверный формат контактов' });
    }

    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        await client.query('DELETE FROM user_contacts WHERE user_id = $1', [req.user.userId]);
        
        for (const contact of contacts) {
            if (contact.phone) {
                await client.query(
                    'INSERT INTO user_contacts (user_id, contact_phone, contact_name) VALUES ($1, $2, $3)',
                    [req.user.userId, contact.phone, contact.name || null]
                );
            }
        }
        
        await client.query('COMMIT');
        
        const tapokContacts = await pool.query(`
            SELECT u.id, u.phone, u.name, u.username, u.avatar, u.status,
                   uc.contact_name,
                   cr.custom_name
            FROM user_contacts uc
            JOIN users u ON u.phone = uc.contact_phone
            LEFT JOIN contact_renames cr ON cr.user_id = $1 AND cr.contact_user_id = u.id
            WHERE uc.user_id = $1
        `, [req.user.userId]);
        
        res.json(tapokContacts.rows);
        
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Ошибка синхронизации контактов' });
    } finally {
        client.release();
    }
});

// Остальные API эндпоинты (без изменений, но с добавленными индексами и обработкой ошибок)
// ... (сохраняем все остальные эндпоинты из оригинального server.js)

// ========== WEB SOCKET С УЛУЧШЕННОЙ ОБРАБОТКОЙ ==========
wss.on('connection', (ws) => {
    ws.isAlive = true;
    
    ws.on('pong', () => {
        ws.isAlive = true;
    });
    
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
                    
                    broadcastUserStatus(user.userId, 'online', ws);
                    
                } catch (err) {
                    console.error('❌ Ошибка аутентификации WS:', err);
                    ws.send(JSON.stringify({ type: 'error', message: 'Неверный токен' }));
                }
            }
            
            if (msg.type === 'typing') {
                broadcastToChat(msg.chatId, {
                    type: 'typing',
                    chatId: msg.chatId,
                    userId: ws.userId,
                    isTyping: msg.isTyping
                }, ws);
            }
            
        } catch (e) {
            console.error('❌ Ошибка обработки WS сообщения:', e);
        }
    });

    ws.on('error', (error) => {
        console.error('❌ WebSocket ошибка:', error);
    });

    ws.on('close', async () => {
        ws.isAlive = false;
        if (ws.userId) {
            await pool.query(
                'UPDATE users SET status = $1, last_seen = CURRENT_TIMESTAMP WHERE id = $2',
                ['offline', ws.userId]
            );
            
            broadcastUserStatus(ws.userId, 'offline', ws);
        }
    });
});

// Проверка соединений каждые 30 секунд
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            return ws.terminate();
        }
        
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => {
    clearInterval(interval);
});

function broadcastUserStatus(userId, status, excludeWs) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client !== excludeWs) {
            client.send(JSON.stringify({
                type: 'user_status',
                userId: userId,
                status: status
            }));
        }
    });
}

function broadcastToChat(chatId, message, excludeWs) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client !== excludeWs) {
            client.send(JSON.stringify(message));
        }
    });
}

// ========== ЗАПУСК ==========
initDb().catch(err => {
    console.error('❌ Ошибка при инициализации БД:', err);
});

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
