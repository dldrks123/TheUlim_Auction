const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- 전역 상태 관리 변수 ---
let auctionItems = []; // CSV에서 로드된 전체 12명의 선수 목록
let connectedPlayers = {}; // { socketId: { nickname: 'A', ready: false, roster: { mid: 0, sup: 0, jungle: 0, ad: 0, acquired: [] } } }
const MAX_PLAYERS = 3;

let gameState = {
    phase: 'Lobby',                   // 'Lobby', 'Bidding_Main', 'Bidding_Failed', 'Finished'
    currentItemIndex: 0,              // 현재 경매 진행 중인 item index (CSV 순서)
    currentItem: null,
    topBid: 0,
    topBidderId: null,                // Socket ID of the highest bidder
    timer: 10,
    auctionInterval: null,
    posAcquired: { mid: 0, sup: 0, jungle: 0, ad: 0 }, // 포지션별 총 낙찰 선수 수
};

const BID_INCREMENT = 10;
const ANTI_SNIPING_WINDOW = 3; // 안티 스나이핑 창: 3초
const ANTI_SNIPING_RESET = 5;  // 타이머 리셋 시간: 5초

// --- 헬퍼 함수 ---

/**
 * 포지션 카운트가 0인 플레이어 중 가장 먼저 찾은 플레이어를 반환합니다.
 */
function getEligibleWinner(position) {
    for (const id in connectedPlayers) {
        if (connectedPlayers[id].roster[position] === 0) {
            return id;
        }
    }
    return null; // 해당 포지션을 획득하지 않은 플레이어가 없는 경우
}

/**
 * 낙찰 카운트가 2가 되었을 때 남은 1명을 자동 낙찰 처리합니다. (핵심 로직)
 */
function checkAndHandleAutoAcquisition(position) {
    if (gameState.posAcquired[position] === 2) {
        
        // 1. 아직 ACQUIRED 상태가 아닌 해당 포지션 선수를 찾습니다.
        const remainingItem = auctionItems.find(item => 
            item.position === position && item.status !== 'ACQUIRED'
        );

        if (remainingItem) {
            const autoWinnerId = getEligibleWinner(position);

            if (autoWinnerId) {
                // 2. 자동 낙찰 실행 (0원으로 낙찰 처리)
                remainingItem.status = 'ACQUIRED';
                remainingItem.finalPrice = 0;
                remainingItem.winnerId = autoWinnerId;
                
                // 3. 상태 및 로스터 갱신
                gameState.posAcquired[position]++; // 총 카운트 3으로 변경
                connectedPlayers[autoWinnerId].roster[position]++;
                connectedPlayers[autoWinnerId].roster.acquired.push({
                    name: remainingItem.name, 
                    price: 0,
                    position: remainingItem.position
                });

                // 4. 클라이언트 전체에 알림
                io.emit('auto_acquisition', { 
                    item: remainingItem, 
                    winner: connectedPlayers[autoWinnerId].nickname 
                });
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

        // 로스터 업데이트
        const winner = connectedPlayers[item.winnerId];
        const position = item.position;
        winner.roster[position]++;
        winner.roster.acquired.push({ name: item.name, price: item.finalPrice, position: position });
        
        // 포지션 총 낙찰 카운트 증가
        gameState.posAcquired[position]++; 
        
        io.emit('auction_result', { status: 'ACQUIRED', item: item, winner: winner.nickname });
        console.log(`[낙찰] ${item.name}이(가) ${item.finalPrice}에 낙찰. 낙찰자: ${winner.nickname}`);

        // ⭐ 자동 낙찰 체크 (핵심)
        checkAndHandleAutoAcquisition(position);
        
    } else {
        // --- 유찰 처리 ---
        item.status = 'FAILED'; // 상태 변경
        io.emit('auction_result', { status: 'FAILED', item: item });
        console.log(`[유찰] ${item.name} 경매 실패.`);
    }

    // 다음 경매로 진행
    gameState.currentItemIndex++;
    if (gameState.currentItemIndex < auctionItems.length) {
        startNextItemAuction();
    } else {
        endMainAuction();
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
    gameState.topBid = gameState.currentItem.price; // 초기 시작가 0
    gameState.topBidderId = null;
    gameState.timer = 10;
    
    // 유찰된 아이템은 건너뜁니다 (2차 경매에서만 다루기 위해)
    if (gameState.currentItem.status === 'ACQUIRED') {
        gameState.currentItemIndex++;
        return startNextItemAuction();
    }

    // 타이머 시작
    gameState.auctionInterval = setInterval(() => {
        gameState.timer--;
        io.emit('update_timer', { itemId: gameState.currentItem.id, time: gameState.timer });

        if (gameState.timer <= 0) {
            checkEndOfAuction();
        }
    }, 1000);

    // 모든 플레이어에게 경매 시작 알림
    io.emit('auction_start', gameState.currentItem);
    console.log(`\n--- 경매 시작: ID ${gameState.currentItem.id} (${gameState.currentItem.name}) ---`);
}

/**
 * 12개의 아이템 경매가 모두 끝났을 때 처리 (유찰 경매 준비)
 */
function endMainAuction() {
    gameState.phase = 'Bidding_Failed';
    const failedItems = auctionItems.filter(item => item.status === 'FAILED');

    if (failedItems.length > 0) {
        // 유찰 아이템 재경매 로직 (간단화: 현재는 콘솔 출력으로 대체)
        io.emit('game_update', { message: `1차 경매 종료. ${failedItems.length}개 유찰. 재경매를 시작합니다.` });
        console.log('--- 1차 경매 종료. 유찰 경매 로직 구현 필요 ---');
        // TODO: 유찰 아이템을 순회하는 새로운 로직 구현
    } else {
        io.emit('game_update', { message: '모든 아이템 낙찰! 경매가 종료되었습니다.' });
        gameState.phase = 'Finished';
        console.log('--- 경매 종료 ---');
    }
}


// --- 초기 CSV 로딩 ---
function loadCSV() {
    const filePath = path.join(__dirname, '..', 'data', 'items.csv');
    fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (row) => {
            auctionItems.push({
                id: row.id,
                name: row.name,
                position: row.position,
                price: parseInt(row.start_price),
                status: 'UNSOLD', // UNSOLD, FAILED, ACQUIRED
            });
        })
        .on('end', () => {
            console.log(`✅ ${auctionItems.length}명의 선수 로딩 완료.`);
        });
}
loadCSV();


// --- Express 및 Socket.io 설정 ---

app.use(express.static('public')); 

// Socket.io 연결 처리
io.on('connection', (socket) => {
    console.log('유저 접속:', socket.id);

    if (Object.keys(connectedPlayers).length < MAX_PLAYERS) {
        // 플레이어 슬롯이 남은 경우
        connectedPlayers[socket.id] = {
            nickname: `P${Object.keys(connectedPlayers).length + 1}`, // 임시 닉네임 부여
            ready: false,
            roster: { mid: 0, sup: 0, jungle: 0, ad: 0, acquired: [] }
        };
        socket.emit('player_info', { id: socket.id, nickname: connectedPlayers[socket.id].nickname });
        io.emit('lobby_update', { players: Object.values(connectedPlayers).map(p => ({ nickname: p.nickname, ready: p.ready })) });
    } else {
        // 관전자 처리
        socket.emit('full_server', '서버에 최대 인원 3명이 접속해 있습니다.');
        socket.disconnect();
        return;
    }

    // [로비: 닉네임 변경] 이벤트
    socket.on('set_nickname', (nickname) => {
        if (connectedPlayers[socket.id]) {
            connectedPlayers[socket.id].nickname = nickname;
            io.emit('lobby_update', { players: Object.values(connectedPlayers).map(p => ({ nickname: p.nickname, ready: p.ready })) });
        }
    });

    // [로비: 준비] 이벤트
    socket.on('ready', () => {
        if (connectedPlayers[socket.id] && !connectedPlayers[socket.id].ready && gameState.phase === 'Lobby') {
            connectedPlayers[socket.id].ready = true;
            
            const readyCount = Object.values(connectedPlayers).filter(p => p.ready).length;
            io.emit('lobby_update', { players: Object.values(connectedPlayers).map(p => ({ nickname: p.nickname, ready: p.ready })) });

            if (readyCount === MAX_PLAYERS) {
                // 3명 모두 준비 완료
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
        
        const currentPrice = gameState.topBid;
        const requiredPrice = currentPrice === 0 ? BID_INCREMENT : currentPrice + BID_INCREMENT;

        if (newPrice >= requiredPrice) {
            // 입찰 성공
            gameState.topBid = newPrice;
            gameState.topBidderId = socket.id;
            
            // 안티 스나이핑 로직
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
            
        } else {
            socket.emit('error_message', `최소 입찰 금액은 ${requiredPrice}입니다.`);
        }
    });

    // 접속 종료 처리
    socket.on('disconnect', () => {
        console.log('유저 접속 종료:', socket.id);
        delete connectedPlayers[socket.id];
        
        // 경매 중이었다면 게임 중단 처리 필요 (여기서는 생략)
        
        io.emit('lobby_update', { players: Object.values(connectedPlayers).map(p => ({ nickname: p.nickname, ready: p.ready })) });
    });
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 TheUlim_Auction 서버 시작 (Port ${PORT})`);
});