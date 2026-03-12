// ========== ОТПРАВКА СООБЩЕНИЙ (исправленная) ==========
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

        // Получаем всех участников чата
        const participants = await client.query(
            'SELECT user_id FROM chat_participants WHERE chat_id = $1 AND user_id != $2',
            [chatId, req.user.userId]
        );

        // Добавляем непрочитанные и отправляем уведомления
        for (const msg of messages) {
            for (const p of participants.rows) {
                await client.query(
                    'INSERT INTO unread_messages (user_id, chat_id, message_id) VALUES ($1, $2, $3)',
                    [p.user_id, chatId, msg.id]
                );
            }
        }

        await client.query('COMMIT');

        // Получаем полные сообщения
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

        // Рассылаем через WebSocket
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

        // ========== ИСПРАВЛЕННЫЕ PUSH-УВЕДОМЛЕНИЯ ==========
        for (const p of participants.rows) {
            const userPush = await pool.query(
                'SELECT push_subscription, name FROM users WHERE id = $1',
                [p.user_id]
            );
            
            if (userPush.rows[0]?.push_subscription) {
                try {
                    // Формируем текст уведомления
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

                    // Подготавливаем данные для уведомления (совместимо с iOS)
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
                        // Важно для iOS и фоновых уведомлений
                        dir: 'auto',
                        lang: 'ru',
                        renotify: true,
                        requireInteraction: true,
                        silent: false,
                        tag: `chat-${chatId}`,
                        timestamp: Date.now()
                    };
                    
                    // Отправляем уведомление
                    await webpush.sendNotification(
                        userPush.rows[0].push_subscription,
                        JSON.stringify(notificationPayload)
                    );
                    
                    console.log(`✅ Push отправлен пользователю ${p.user_id}`);
                    
                } catch (e) {
                    console.error(`❌ Ошибка отправки push пользователю ${p.user_id}:`, e.message);
                    
                    // Если подписка истекла или недействительна (410 Gone)
                    if (e.statusCode === 410 || e.message.includes('expired')) {
                        console.log(`🗑️ Удаляем нерабочую подписку пользователя ${p.user_id}`);
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

// ========== ДОБАВИТЬ В КОНЕЦ ФАЙЛА (перед server.listen) ==========
// Middleware для Service Worker (важно для iOS)
app.use((req, res, next) => {
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    next();
});

// Эндпоинт для проверки подписки
app.get('/api/push/status', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT push_subscription FROM users WHERE id = $1',
            [req.user.userId]
        );
        
        res.json({ 
            subscribed: !!result.rows[0]?.push_subscription,
            browser: req.headers['user-agent']
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
