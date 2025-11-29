const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- 상수 및 전역 상태 관리 변수 ---
let auctionItems = []; // CSV에서 로드된 전체 12명의 선수 목록
let connectedPlayers = {}; 
const MAX_PLAYERS = 3;

let gameState = {
    phase: 'Lobby',                   // 'Lobby', 'Bidding_Main', 'Bidding_Failed', 'Finished'
    currentItemIndex: 0,              
    currentItem: null,
    topBid: 0,
    topBidderId: null,                
    timer: 0, // 매 경매 시작 시 설정됨
    auctionInterval: null,
    posAcquired: { mid: 0, sup: 0, jungle: 0, ad: 0 }, 
};

// ⭐ 경매 시간 관련 상수 변경
const MAX_TIME = 15;        // ⭐ 일반 경매 시작 시간 15초
const FAILED_START_TIME = 30; // ⭐ 유찰 경매 첫 매물 시간 30초
const BID_INCREMENT = 10;
const MIN_START_BID = 50; 
const ANTI_SNIPING_WINDOW = 3; 
const ANTI_SNIPING_RESET = 8; // ⭐ 입찰 시 타이머 리셋 시간 8초
const STARTING_POINTS = 1000; 

// --- 헬퍼 함수 ---

/**
 * 배열을 섞는 Fisher-Yates 알고리즘
 */
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

/**
 * 포지션 카운트가 0인 플레이어 중 가장 먼저 찾은 플레이어를 반환합니다.
 */
function getEligibleWinner(position) {
    for (const id in connectedPlayers) {
        if (connectedPlayers[id].roster[position] === 0) {
            return id;
        }
    }
    return null;
}

/**
 * 낙찰 카운트가 2가 되었을 때 남은 1명을 자동 낙찰 처리합니다.
 */
function checkAndHandleAutoAcquisition(position) {
    if (gameState.posAcquired[position] === 2) {
        
        const remainingItem = auctionItems.find(item => 
            item.position === position && item.status !== 'ACQUIRED'
        );

        if (remainingItem) {
            const autoWinnerId = getEligibleWinner(position);

            if (autoWinnerId) {
                // 자동 낙찰 실행 (0원으로 낙찰 처리)
                remainingItem.status = 'ACQUIRED';
                remainingItem.finalPrice = 0;
                remainingItem.winnerId = autoWinnerId;
                
                // 상태 및 로스터 갱신
                gameState.posAcquired[position]++; 
                connectedPlayers[autoWinnerId].roster[position]++;
                connectedPlayers[autoWinnerId].roster.acquired.push({
                    name: remainingItem.name, 
                    price: 0,
                    position: remainingItem.position
                });

                // 클라이언트 전체에 알림 및 상태 업데이트
                io.emit('auto_acquisition', { 
                    item: remainingItem, 
                    winner: connectedPlayers[autoWinnerId].nickname 
                });
                sendPlayerStatusUpdate(); 
                sendAuctionStatusUpdate();
                console.log(`⭐ [자동 낙찰] ${remainingItem.name} (${position}) 선수, ${connectedPlayers[autoWinnerId].nickname} 플레이어에게 0원으로 자동 낙찰됨.`);
            }
        }
    }
}

/**
 * 현재 아이템의 경매를 종료하고 다음 단계로 진행합니다.
 */
function checkEndOfAuction() {
    clearInterval(gameState.auctionInterval);
    const item = gameState.currentItem;

    if (gameState.topBid > 0) {
        // --- 낙찰 처리 ---
        item.status = 'ACQUIRED';
        item.finalPrice = gameState.topBid;
        item.winnerId = gameState.topBidderId;

        const winner = connectedPlayers[item.winnerId];
        const position = item.position;

        winner.points -= item.finalPrice; 
        winner.roster[position]++;
        winner.roster.acquired.push({ name: item.name, price: item.finalPrice, position: position });
        gameState.posAcquired[position]++; 
        
        io.emit('auction_result', { status: 'ACQUIRED', item: item, winner: winner.nickname });
        
        sendPlayerStatusUpdate(); 
        sendAuctionStatusUpdate();
        
        console.log(`[낙찰] ${item.name}이(가) ${item.finalPrice}에 낙찰. 낙찰자: ${winner.nickname}`);

        checkAndHandleAutoAcquisition(position);
        
    } else {
        // --- 유찰 처리 ---
        item.status = 'FAILED'; 
        io.emit('auction_result', { status: 'FAILED', item: item });
        sendAuctionStatusUpdate(); 
        console.log(`[유찰] ${item.name} 경매 실패.`);
    }

    // 다음 경매로 진행
    gameState.currentItemIndex++;
    if (gameState.phase === 'Bidding_Main' && gameState.currentItemIndex < auctionItems.length) {
        startNextItemAuction();
    } else if (gameState.phase === 'Bidding_Main' && gameState.currentItemIndex >= auctionItems.length) {
        endMainAuction();
    } else if (gameState.phase === 'Bidding_Failed' && gameState.currentItemIndex < auctionItems.filter(i => i.status === 'FAILED').length) {
        startFailedAuction(); // 2차 경매 진행
    } else {
        // 모든 경매 종료
        io.emit('game_update', { message: '모든 경매가 최종 종료되었습니다.' });
        gameState.phase = 'Finished';
        console.log('--- 최종 경매 종료 ---');
    }
}

/**
 * 다음 아이템의 경매를 시작합니다.
 */
function startNextItemAuction() {
    if (gameState.currentItemIndex >= auctionItems.length) {
        return;
    }
    
    gameState.currentItem = auctionItems[gameState.currentItemIndex];
    gameState.topBid = 0; 
    gameState.topBidderId = null;
    gameState.timer = MAX_TIME; // ⭐ 1차 경매 기본 시간 15초
    
    // 이미 낙찰된 아이템은 건너뜁니다.
    if (gameState.currentItem.status === 'ACQUIRED') {
        gameState.currentItemIndex++;
        return startNextItemAuction();
    }

    // 타이머 시작
    if (gameState.auctionInterval) clearInterval(gameState.auctionInterval);
    gameState.auctionInterval = setInterval(() => {
        gameState.timer--;
        io.emit('update_timer', { itemId: gameState.currentItem.id, time: gameState.timer });

        if (gameState.timer <= 0) {
            checkEndOfAuction();
        }
    }, 1000);

    io.emit('auction_start', gameState.currentItem);
    sendAuctionStatusUpdate(); 
    console.log(`\n--- 1차 경매 시작: ID ${gameState.currentItem.id} (${gameState.currentItem.name}) ---`);
}

/**
 * 12개의 아이템 경매가 모두 끝났을 때 처리 (유찰 경매 준비)
 */
function endMainAuction() {
    const failedItems = auctionItems.filter(item => item.status === 'FAILED');

    if (failedItems.length > 0) {
        gameState.phase = 'Bidding_Failed';
        gameState.currentItemIndex = 0; // 유찰 목록 인덱스 초기화
        io.emit('game_update', { message: `1차 경매 종료. ${failedItems.length}개 유찰. 유찰 경매를 시작합니다!` });
        console.log('--- 1차 경매 종료. 유찰 경매 시작 ---');
        
        // 유찰된 아이템만 모아서 새로운 임시 배열을 만들어 순회할 수 있도록 로직 변경
        auctionItems = auctionItems.filter(item => item.status !== 'ACQUIRED'); // 낙찰된 아이템은 제거
        
        // 유찰 경매 시작 함수 호출
        startFailedAuction();
    } else {
        io.emit('game_update', { message: '모든 아이템 낙찰! 경매가 종료되었습니다.' });
        gameState.phase = 'Finished';
        console.log('--- 경매 종료 ---');
    }
}

/**
 * 유찰된 아이템의 경매를 시작합니다.
 */
function startFailedAuction() {
    const failedItems = auctionItems.filter(i => i.status === 'FAILED');

    if (gameState.currentItemIndex >= failedItems.length) {
        return checkEndOfAuction(); // 유찰 목록 순회 완료
    }

    gameState.currentItem = failedItems[gameState.currentItemIndex];
    gameState.topBid = 0; 
    gameState.topBidderId = null;
    
    // ⭐ 첫 유찰 매물에 30초 부여, 나머지는 15초
    gameState.timer = gameState.currentItemIndex === 0 ? FAILED_START_TIME : MAX_TIME; 

    // 타이머 시작
    if (gameState.auctionInterval) clearInterval(gameState.auctionInterval);
    gameState.auctionInterval = setInterval(() => {
        gameState.timer--;
        io.emit('update_timer', { itemId: gameState.currentItem.id, time: gameState.timer });

        if (gameState.timer <= 0) {
            checkEndOfAuction();
        }
    }, 1000);

    io.emit('auction_start', gameState.currentItem);
    sendAuctionStatusUpdate(); 
    console.log(`\n--- 2차 경매 시작: ID ${gameState.currentItem.id} (${gameState.currentItem.name}) ---`);
}

/**
 * 모든 플레이어의 현재 상태(닉네임, 포인트, 로스터)를 클라이언트에 전송합니다.
 */
function sendPlayerStatusUpdate() {
    const playerStatuses = Object.entries(connectedPlayers).map(([id, player]) => ({
        id: id,
        nickname: player.nickname,
        points: player.points,
        roster: player.roster.acquired,
        isTopBidder: id === gameState.topBidderId
    }));
    io.emit('player_status_update', playerStatuses);
}

/**
 * 전체 경매 목록 현황(순서, 상태)을 클라이언트에 전송합니다.
 */
function sendAuctionStatusUpdate() {
    const auctionStatus = auctionItems.map(item => ({
        id: item.id,
        name: item.name,
        position: item.position,
        status: item.status,
    }));
    io.emit('auction_status_update', auctionStatus);
}


// --- 초기 CSV 로딩 ---
function loadCSV() {
    const filePath = path.join(__dirname, '..', 'data', 'items.csv');
    const itemsBeforeShuffle = [];
    fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (row) => {
            itemsBeforeShuffle.push({
                id: row.id,
                name: row.name,
                position: row.position,
                price: parseInt(row.start_price), 
                status: 'UNSOLD', 
                winnerId: null,
                finalPrice: 0,
            });
        })
        .on('end', () => {
            // ⭐ 로드 완료 후 순서 랜덤 섞기
            shuffleArray(itemsBeforeShuffle);
            auctionItems = itemsBeforeShuffle;
            console.log(`✅ ${auctionItems.length}명의 선수 로딩 및 순서 랜덤 섞기 완료.`);
        });
}
loadCSV();


// --- Socket.io 이벤트 핸들러 ---
io.on('connection', (socket) => {
    
    // ... (로비/접속 로직 생략, 기존과 동일) ...
    if (Object.keys(connectedPlayers).length < MAX_PLAYERS) {
        connectedPlayers[socket.id] = {
            nickname: `P${Object.keys(connectedPlayers).length + 1}`,
            ready: false,
            points: STARTING_POINTS,
            roster: { mid: 0, sup: 0, jungle: 0, ad: 0, acquired: [] }
        };
        socket.emit('player_info', { id: socket.id, nickname: connectedPlayers[socket.id].nickname });
        io.emit('lobby_update', { players: Object.values(connectedPlayers).map(p => ({ nickname: p.nickname, ready: p.ready })) });
        
        sendPlayerStatusUpdate();
        sendAuctionStatusUpdate();
        
    } else {
        socket.emit('full_server', '서버에 최대 인원 3명이 접속해 있습니다.');
        socket.disconnect();
        return;
    }

    socket.on('set_nickname', (nickname) => {
        if (connectedPlayers[socket.id]) {
            connectedPlayers[socket.id].nickname = nickname;
            io.emit('lobby_update', { players: Object.values(connectedPlayers).map(p => ({ nickname: p.nickname, ready: p.ready })) });
            sendPlayerStatusUpdate(); 
        }
    });

    socket.on('ready', () => {
        if (connectedPlayers[socket.id] && !connectedPlayers[socket.id].ready && gameState.phase === 'Lobby') {
            connectedPlayers[socket.id].ready = true;
            
            const readyCount = Object.values(connectedPlayers).filter(p => p.ready).length;
            io.emit('lobby_update', { players: Object.values(connectedPlayers).map(p => ({ nickname: p.nickname, ready: p.ready })) });

            if (readyCount === MAX_PLAYERS) {
                gameState.phase = 'Bidding_Main';
                io.emit('game_start', '3명 모두 준비 완료! 경매를 시작합니다.');
                startNextItemAuction();
            }
        }
    });

    // [경매: 입찰] 이벤트
    socket.on('bid', (newPrice) => {
        if (gameState.phase !== 'Bidding_Main' && gameState.phase !== 'Bidding_Failed') return;
        if (!connectedPlayers[socket.id]) return;
        
        // 1. 연속 입찰 금지
        if (socket.id === gameState.topBidderId) {
            return socket.emit('error_message', '연속 입찰은 불가능합니다. 다음 플레이어만 입찰할 수 있습니다.');
        }

        // 2. 10 포인트 단위 체크
        if (newPrice % BID_INCREMENT !== 0) {
            return socket.emit('error_message', `입찰은 ${BID_INCREMENT} 포인트 단위로만 가능합니다.`);
        }

        const currentPrice = gameState.topBid;
        const player = connectedPlayers[socket.id];
        
        // 3. 최소 입찰 금액 계산 (50p 시작 & 10p 증분)
        let requiredPrice;
        if (currentPrice === 0) {
            requiredPrice = MIN_START_BID;
        } else {
            requiredPrice = currentPrice + BID_INCREMENT; 
        }

        if (newPrice < requiredPrice) {
            return socket.emit('error_message', `최소 입찰 금액은 ${requiredPrice} 포인트입니다.`);
        }
        
        // 4. 포인트 잔액 확인
        if (newPrice > player.points) {
            return socket.emit('error_message', `보유 포인트(${player.points}p)보다 높은 금액(${newPrice}p)으로는 입찰할 수 없습니다.`);
        }
        
        // 입찰 성공 처리
        gameState.topBid = newPrice;
        gameState.topBidderId = socket.id;
        
        // 안티 스나이핑
        if (gameState.timer <= ANTI_SNIPING_WINDOW) {
            gameState.timer = ANTI_SNIPING_RESET;
            io.emit('update_timer', { itemId: gameState.currentItem.id, time: gameState.timer });
            console.log(`[Sniping] 타이머가 ${ANTI_SNIPING_RESET}초로 리셋되었습니다.`);
        }

        io.emit('update_bid', { 
            itemId: gameState.currentItem.id, 
            price: newPrice, 
            bidder: connectedPlayers[socket.id].nickname 
        });
        
        // 입찰 시 플레이어 상태 업데이트 (UI에 남은 포인트가 붉은색으로 표시되는 등의 효과를 위해)
        sendPlayerStatusUpdate();
    });

    socket.on('disconnect', () => {
        delete connectedPlayers[socket.id];
        io.emit('lobby_update', { players: Object.values(connectedPlayers).map(p => ({ nickname: p.nickname, ready: p.ready })) });
        sendPlayerStatusUpdate();
    });
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 TheUlim_Auction 서버 시작 (Port ${PORT})`);
});