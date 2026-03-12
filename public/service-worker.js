self.addEventListener('push', function(event) {
    const data = event.data.json();
    
    const options = {
        body: data.body,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-72.png',
        vibrate: [200, 100, 200],
        data: {
            url: data.url,
            chatId: data.chatId
        },
        actions: [
            {
                action: 'open',
                title: 'Открыть чат'
            },
            {
                action: 'close',
                title: 'Закрыть'
            }
        ]
    };
    
    event.waitUntil(
        self.registration.showNotification(data.title || 'Tapok', options)
    );
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    
    if (event.action === 'close') return;
    
    const urlToOpen = event.notification.data.url || '/';
    
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then(function(clientList) {
                for (let client of clientList) {
                    if (client.url === urlToOpen && 'focus' in client) {
                        return client.focus();
                    }
                }
                return clients.openWindow(urlToOpen);
            })
    );
});