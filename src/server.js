const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// 정적 파일 경로 설정: public 폴더를 서비스합니다.
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- 상수 및 전역 상태 관리 변수 ---
let auctionItems = []; // CSV에서 로드된 전체 12명의 선수 목록
let initialAuctionItems = []; // 초기 경매 아이템 상태 저장용 (순서 고정)
let connectedPlayers = {};
const MAX_PLAYERS = 3;

let gameState = {
    phase: 'Lobby', 					// 'Lobby', 'Wait_Next_Item', 'Bidding_Main', 'Bidding_Failed', 'Finished'
    currentItemIndex: 0, // 1차 경매 순회용 인덱스 (0부터 initialAuctionItems.length-1까지)
    failedAuctionIndex: 0, // 2차 유찰 경매 순회용 인덱스 (0부터 failedItems.length-1까지)
    failedAuctionRound: 0, // 유찰 경매 순회 횟수 (무한 순환 추적용)
    currentItem: null,
    topBid: 0,
    topBidderId: null,
    timer: 0, // 매 경매 시작 시 설정됨
    auctionInterval: null,
    preAuctionTimerInterval: null, // 다음 경매 대기 타이머
    posAcquired: { mid: 0, sup: 0, jungle: 0, ad: 0, top: 0 }, // 각 포지션별 낙찰된 총 선수 수
};

// 경매 시간 및 규칙 상수
const MAX_TIME = 12; 		// 일반 경매 시작 시간 12초
const FAILED_START_TIME = 15; // 유찰 경매 첫 매물 시간 15초
const BID_INCREMENT = 10;
const MIN_START_BID = 10;
const ANTI_SNIPING_RESET = 7; // 입찰 시 타이머 리셋 시간 7초
const DEFAULT_STARTING_POINTS = 1000;
const MAX_POS_PER_PLAYER = 1; 
const WAIT_TIME = 5; // 다음 경매 전 대기 시간 5초

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
        // 해당 포지션의 선수가 0명인 플레이어를 찾음 (자동 낙찰 대상)
        if (connectedPlayers[id].roster[position] === 0) {
            return id;
        }
    }
    return null;
}

/**
 * 최종 경매 종료 후 로비로 돌아가기 위해 초기화합니다.
 */
function resetGame() {
    console.log('\n--- 🔁 게임 상태 초기화 시작 ---');

    if (gameState.auctionInterval) clearInterval(gameState.auctionInterval);
    if (gameState.preAuctionTimerInterval) clearInterval(gameState.preAuctionTimerInterval);

    // 1. 게임 상태 초기화
    gameState = {
        phase: 'Lobby',
        currentItemIndex: 0,
        failedAuctionIndex: 0,
        failedAuctionRound: 0,
        currentItem: null,
        topBid: 0,
        topBidderId: null,
        timer: 0,
        auctionInterval: null,
        preAuctionTimerInterval: null,
        posAcquired: { mid: 0, sup: 0, jungle: 0, ad: 0, top: 0 },
    };

    // 2. 경매 아이템 목록 초기화 및 재셔플
    // auctionItems (순서 고정)의 깊은 복사본을 만들어 초기 상태를 복구
    let itemsForShuffle = initialAuctionItems.map(item => ({ ...item, status: 'UNSOLD', winnerId: null, finalPrice: 0 }));
    shuffleArray(itemsForShuffle);
    auctionItems = itemsForShuffle;
    initialAuctionItems = JSON.parse(JSON.stringify(itemsForShuffle)); // 새로운 초기 순서 저장

    // 3. 플레이어 정보 초기화 (포인트 및 로스터)
    for (const id in connectedPlayers) {
        connectedPlayers[id].ready = false;
        connectedPlayers[id].points = connectedPlayers[id].startPoints || DEFAULT_STARTING_POINTS;
        connectedPlayers[id].roster = { mid: 0, sup: 0, jungle: 0, ad: 0, top: 0, acquired: [] };
    }

    // 4. 클라이언트에게 초기화 상태 전송
    io.emit('game_update', { message: '✅ 경매가 자동으로 초기화되어 로비로 돌아갑니다. "준비 완료" 버튼을 다시 눌러주세요.' });
    io.emit('lobby_update', { players: Object.values(connectedPlayers).map(p => ({ nickname: p.nickname, ready: p.ready })) });
    sendPlayerStatusUpdate();
    sendAuctionStatusUpdate();
    console.log('--- ✅ 게임 상태 초기화 완료. 로비 모드로 전환됨 ---');
}


/**
 * 자동 낙찰 처리
 */
function checkAndHandleAutoAcquisition(position) {
    // 3명 중 2명이 포지션을 획득했을 때 (posAcquired[position] === 2)
    // 나머지 1명에게 남은 1명의 선수를 자동 낙찰 처리합니다.
    if (gameState.posAcquired[position] === MAX_PLAYERS - 1) {

        // 아직 'ACQUIRED' 상태가 아닌 해당 포지션의 선수 1명을 찾습니다.
        // NOTE: initialAuctionItems 배열을 기준으로 찾으므로, 상태 업데이트가 여기에 반영됨.
        const remainingItem = initialAuctionItems.find(item =>
            item.position === position && item.status !== 'ACQUIRED'
        );

        if (remainingItem) {
            // 해당 포지션의 선수가 0명인 플레이어를 찾습니다.
            const autoWinnerId = getEligibleWinner(position);

            if (autoWinnerId) {
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
    if (gameState.auctionInterval) clearInterval(gameState.auctionInterval);
    const item = gameState.currentItem;

    // 현재 아이템은 initialAuctionItems와 auctionItems 모두에 동일한 참조가 되도록 처리
    const originalItem = initialAuctionItems.find(i => i.id === item.id) || item;

    if (gameState.topBid > 0) {
        // --- 낙찰 처리 ---
        originalItem.status = 'ACQUIRED';
        originalItem.finalPrice = gameState.topBid;
        originalItem.winnerId = gameState.topBidderId;

        const winner = connectedPlayers[originalItem.winnerId];
        const position = originalItem.position.toLowerCase(); // 포지션은 소문자로 저장

        winner.points -= originalItem.finalPrice;
        winner.roster[position]++;
        winner.roster.acquired.push({ name: originalItem.name, price: originalItem.finalPrice, position: position });
        gameState.posAcquired[position]++;

        io.emit('auction_result', { status: 'ACQUIRED', item: originalItem, winner: winner.nickname });

        sendPlayerStatusUpdate();
        sendAuctionStatusUpdate();

        console.log(`[낙찰] ${originalItem.name}이(가) ${originalItem.finalPrice}에 낙찰. 낙찰자: ${winner.nickname}`);

        checkAndHandleAutoAcquisition(position);

    } else {
        // --- 유찰 처리 ---
        originalItem.status = 'FAILED';
        io.emit('auction_result', { status: 'FAILED', item: originalItem });
        sendAuctionStatusUpdate();
        console.log(`[유찰] ${originalItem.name} 경매 실패. (phase: ${gameState.phase})`);
    }

    // 다음 경매 대기 타이머 시작
    startPreAuctionWait();
}

/**
 * 낙찰/유찰 후 다음 경매 시작 전 5초 대기 타이머를 시작합니다.
 * 1차 경매와 유찰 경매의 아이템 순회 로직을 처리합니다.
 */
function startPreAuctionWait() {
    gameState.phase = 'Wait_Next_Item';
    sendPlayerStatusUpdate();

    let nextItem = null;
    let isFailedAuction = false;

    // --- 1차 경매 순서 처리 ---
    if (gameState.currentItemIndex < initialAuctionItems.length) {
        
        // 1차 경매 아이템을 순서대로 순회
        nextItem = initialAuctionItems[gameState.currentItemIndex];
        
        // 이미 낙찰된 아이템은 건너뛰고 다음 아이템을 찾습니다.
        if (nextItem.status === 'ACQUIRED') {
            gameState.currentItemIndex++; // 건너뛴 아이템의 인덱스 증가
            console.log(`[시스템] ${nextItem.name} 선수는 이미 낙찰되어 건너뜁니다.`);
            return startPreAuctionWait(); 
        }

        // 포지션 제한으로 경매 자체가 불가능한 경우 (건너뛰기)
        const nextItemPosition = nextItem.position.toLowerCase();
        if (gameState.posAcquired[nextItemPosition] >= MAX_PLAYERS) {
            // 해당 아이템을 'ACQUIRED'로 상태만 변경 (0원 처리), 경매 종료에 영향 X
            nextItem.status = 'ACQUIRED';
            gameState.currentItemIndex++; // 건너뛴 아이템의 인덱스 증가
            console.log(`[시스템] ${nextItem.name} (${nextItemPosition}) 선수는 이미 모든 포지션에 낙찰자가 나와 건너뛰고 다음 선수를 탐색합니다.`);
            
            // 건너뛴 후 다음 아이템을 찾기 위해 재귀 호출
            return startPreAuctionWait(); 
        }

        // 1차 경매에서 사용할 다음 인덱스 증가 (아이템 선택이 완료된 후)
        gameState.currentItemIndex++; 

    } 
    // --- 유찰 경매 순서 처리 (1차 경매가 끝났을 때부터 시작) ---
    else {
        
        // 현재 유찰된 선수 목록을 필터링합니다. (FAILED 상태인 선수들)
        const failedItems = initialAuctionItems.filter(item => item.status === 'FAILED');
        
        // 1차 경매가 막 끝났을 때 알림 메시지 전송 및 failedAuctionRound 초기화
        if (gameState.failedAuctionRound === 0) {
             const failedCount = failedItems.length; // 현재 시점의 유찰 수
             io.emit('game_update', { message: `1차 경매 종료. ${failedCount}개 유찰. 유찰 경매를 시작합니다.` });
             console.log('--- 1차 경매 종료. 유찰 경매 시작 ---');
             gameState.failedAuctionRound = 1;
             gameState.failedAuctionIndex = 0; // 유찰 경매 인덱스 초기화
        }

        // 유찰 목록을 모두 순회했을 경우
        if (gameState.failedAuctionIndex >= failedItems.length) {
            
            // 아직 유찰된 선수가 남아 있다면 (무한 순환)
            if (failedItems.length > 0) {
                // 인덱스를 초기화하고 다음 라운드 시작
                gameState.failedAuctionIndex = 0;
                gameState.failedAuctionRound++;
                console.log(`[시스템] 유찰 경매 순회 완료. 아직 ${failedItems.length}개 유찰 잔여. ${gameState.failedAuctionRound}차 재순회 시작.`);
                io.emit('game_update', { message: `${gameState.failedAuctionRound}차 유찰 경매 재순회를 시작합니다. (잔여 ${failedItems.length}개)` });
            } else {
                // 유찰된 선수가 더 이상 없으므로 최종 종료
                clearInterval(gameState.preAuctionTimerInterval);
                handleFinalAuctionEnd();
                return;
            }
        }
        
        // 다음 유찰 아이템 선택 (failedItems.length > 0 인 경우에만 실행)
        if (failedItems.length > 0) {
            nextItem = failedItems[gameState.failedAuctionIndex];
            isFailedAuction = true;
            
            // 🚨 핵심 수정: 포지션 제한 건너뛰기 로직
            const nextItemPosition = nextItem.position.toLowerCase();
            if (gameState.posAcquired[nextItemPosition] >= MAX_PLAYERS) {
                // 해당 아이템을 'ACQUIRED'로 상태만 변경 (0원 처리), 경매 종료에 영향 X
                nextItem.status = 'ACQUIRED';
                gameState.failedAuctionIndex++; // 건너뛴 아이템의 인덱스 증가
                console.log(`[시스템] ${nextItem.name} (${nextItemPosition}) 선수는 이미 모든 포지션에 낙찰자가 나와 건너뛰고 다음 유찰 선수를 탐색합니다.`);
                
                // 건너뛴 후 다음 아이템을 찾기 위해 재귀 호출
                return startPreAuctionWait(); 
            }

            // 아이템 선택이 완료된 후 인덱스 증가 (순환 로직)
            gameState.failedAuctionIndex++;
        }
    }

    // nextItem이 null이 아니어야 함 (정상적인 아이템이 선택되었을 때만 타이머 시작)
    if (!nextItem) {
        // 유찰 경매 순회 중 모든 아이템이 ACQUIRED 상태로 건너뛰어 nextItem이 null이 된 경우
        const remainingFailed = initialAuctionItems.filter(item => item.status === 'FAILED');
        if (remainingFailed.length === 0) {
             console.log("경매 순회 완료: 잔여 유찰 아이템 없음.");
             handleFinalAuctionEnd();
             return;
        }

        // 혹시 모를 안전 장치: 재귀 호출을 통해 다음 아이템을 찾거나 최종 종료 시도
        console.warn("경고: nextItem이 null입니다. 다음 순회 시도.");
        return startPreAuctionWait();
    }


    let waitTime = WAIT_TIME;
    io.emit('pre_auction_wait', {
        time: waitTime,
        nextItem: nextItem ? { name: nextItem.name, position: nextItem.position } : null,
        isFailedAuction: isFailedAuction
    });

    if (gameState.preAuctionTimerInterval) clearInterval(gameState.preAuctionTimerInterval);
    gameState.preAuctionTimerInterval = setInterval(() => {
        waitTime--;
        io.emit('pre_auction_wait', {
            time: waitTime,
            nextItem: nextItem ? { name: nextItem.name, position: nextItem.position } : null,
            isFailedAuction: isFailedAuction
        });

        if (waitTime <= 0) {
            clearInterval(gameState.preAuctionTimerInterval);
            
            // Phase를 설정하고 경매 시작
            gameState.phase = isFailedAuction ? 'Bidding_Failed' : 'Bidding_Main';
            startNextItemAuction(nextItem);
        }
    }, 1000);
}

/**
 * 다음 아이템의 경매를 시작합니다.
 * @param {object} item - 경매를 진행할 아이템 객체 (initialAuctionItems의 요소에 대한 참조)
 */
function startNextItemAuction(item) {
    if (!item) {
        // 이미 startPreAuctionWait에서 최종 종료를 처리했으나, 혹시 모를 안전 장치
        handleFinalAuctionEnd();
        return;
    }

    gameState.currentItem = item;
    gameState.topBid = 0;
    gameState.topBidderId = null;
    
    // 1차 경매(Bidding_Main)는 MAX_TIME(12초), 유찰 경매(Bidding_Failed)는 FAILED_START_TIME(15초)
    gameState.timer = gameState.phase === 'Bidding_Main' ? MAX_TIME : FAILED_START_TIME;

    // 타이머 시작
    if (gameState.auctionInterval) clearInterval(gameState.auctionInterval);
    gameState.auctionInterval = setInterval(() => {
        gameState.timer--;
        io.emit('update_timer', { itemId: gameState.currentItem.id, time: gameState.timer });

        if (gameState.timer <= 0) {
            checkEndOfAuction();
        }
    }, 1000);

    // 💡 클라이언트에 Phase 정보도 함께 전송하여 UI 업데이트에 사용
    io.emit('auction_start', {
        item: gameState.currentItem,
        phase: gameState.phase
    }); 
    sendAuctionStatusUpdate();
    // 경매 시작 시 플레이어 상태 업데이트 (입찰 가능 여부 반영)
    sendPlayerStatusUpdate();
    console.log(`\n--- ${gameState.phase === 'Bidding_Main' ? '1차' : `${gameState.failedAuctionRound}차 유찰`} 경매 시작: ID ${gameState.currentItem.id} (${gameState.currentItem.name}) ---`);
}


/**
 * 최종 경매 종료 처리 및 60초 초기화 타이머 시작
 */
function handleFinalAuctionEnd() {
    gameState.phase = 'Finished';
    console.log('--- 최종 경매 종료 ---');

    // 60초 후 자동 초기화 타이머 설정
    io.emit('game_update', { message: '모든 경매가 최종 종료되었습니다. 60초 후 자동으로 로비로 돌아가 초기화됩니다.' });

    let countdown = 60;
    const resetInterval = setInterval(() => {
        countdown--;
        // 최종 종료 메시지 업데이트
        io.emit('game_update', { message: `모든 경매가 최종 종료되었습니다. ${countdown}초 후 자동으로 로비로 돌아가 초기화됩니다.` });

        if (countdown <= 0) {
            clearInterval(resetInterval);
            resetGame(); // 게임 상태 초기화 함수 호출
        }
    }, 1000);
}


/**
 * 모든 플레이어의 현재 상태(닉네임, 포인트, 로스터, 입찰 가능 여부)를 클라이언트에 전송합니다.
 */
function sendPlayerStatusUpdate() {
    // 현재 경매 중인 아이템의 포지션을 소문자로 가져옴
    const itemPosition = gameState.currentItem ? gameState.currentItem.position.toLowerCase() : null;

    const playerStatuses = Object.entries(connectedPlayers).map(([id, player]) => {
        let canBid = true;

        // 1. 경매 중이 아닐 때 입찰 불가
        if (gameState.phase !== 'Bidding_Main' && gameState.phase !== 'Bidding_Failed') {
            canBid = false;
        }

        // 2. 본인이 최고 입찰자일 때 연속 입찰 불가
        if (id === gameState.topBidderId) {
            canBid = false;
        }
        
        // 3. 🛑 포지션 제한 체크 (해당 포지션 선수를 1명 보유했으면 입찰 불가)
        if (itemPosition && player.roster[itemPosition] >= MAX_POS_PER_PLAYER) { 
            canBid = false; // 🛑 이 플레이어는 이 포지션에 대해 입찰 불가
        }
        
        // 4. 포인트 부족 시 입찰 불가 (클라이언트에서 처리)
        
        return {
            id: id,
            nickname: player.nickname,
            points: player.points,
            roster: player.roster.acquired,
            isTopBidder: id === gameState.topBidderId,
            canBid: canBid, // 클라이언트에서 버튼 비활성화에 사용
        };
    });
    io.emit('player_status_update', playerStatuses);
}

/**
 * 전체 경매 목록 현황(순서, 상태)을 클라이언트에 전송합니다.
 */
function sendAuctionStatusUpdate() {
    const auctionStatus = initialAuctionItems.map((item, index) => ({
        sequence: index + 1,
        id: item.id, // 클라이언트에서 현재 경매 물품 하이라이트를 위해 ID 추가
        name: item.name,
        position: item.position,
        status: item.status,
    }));
    io.emit('auction_status_update', auctionStatus);
}


// --- 초기 CSV 로딩 ---
function loadCSV() {
    // 현재 server.js는 src/ 폴더에 있다고 가정하고, items.csv는 data/ 폴더에 있다고 가정합니다.
    const filePath = path.join(__dirname, '..', 'data', 'items.csv');
    const itemsBeforeShuffle = [];
    fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (row) => {
            itemsBeforeShuffle.push({
                id: row.id,
                name: row.name,
                // 모든 포지션을 소문자로 통일하여 처리
                position: row.position.toLowerCase(),
                price: parseInt(row.start_price),
                status: 'UNSOLD',
                winnerId: null,
                finalPrice: 0,
            });
        })
        .on('end', () => {
            shuffleArray(itemsBeforeShuffle);
            auctionItems = itemsBeforeShuffle;
            initialAuctionItems = JSON.parse(JSON.stringify(itemsBeforeShuffle));
            console.log(`✅ ${auctionItems.length}명의 선수 로딩 및 순서 랜덤 섞기 완료.`);
        });
}
loadCSV();


// --- Socket.io 이벤트 핸들러 ---
io.on('connection', (socket) => {

    if (Object.keys(connectedPlayers).length < MAX_PLAYERS) {
        const initialPoints = DEFAULT_STARTING_POINTS;
        connectedPlayers[socket.id] = {
            nickname: `P${Object.keys(connectedPlayers).length + 1}`,
            ready: false,
            points: initialPoints,
            startPoints: initialPoints,
            roster: { mid: 0, sup: 0, jungle: 0, ad: 0, top: 0, acquired: [] }
        };
        socket.emit('player_info', { id: socket.id, nickname: connectedPlayers[socket.id].nickname, points: initialPoints });
        io.emit('lobby_update', { players: Object.values(connectedPlayers).map(p => ({ nickname: p.nickname, ready: p.ready })) });

        sendPlayerStatusUpdate();
        sendAuctionStatusUpdate();

    } else {
        socket.emit('full_server', '서버에 최대 인원 3명이 접속해 있습니다.');
        socket.disconnect();
        return;
    }

    // 닉네임과 시작 포인트 설정
    socket.on('set_nickname_and_points', (data) => {
        const { nickname, points } = data;
        if (connectedPlayers[socket.id] && nickname) {
            if (points % BID_INCREMENT !== 0 || points <= 0) {
                return socket.emit('error_message', `시작 포인트는 ${BID_INCREMENT} 포인트 단위로 0보다 크게 설정해야 합니다.`);
            }

            connectedPlayers[socket.id].nickname = nickname;
            connectedPlayers[socket.id].points = points;
            connectedPlayers[socket.id].startPoints = points;
            
            // 포인트 변경 시 로스터 초기화
            connectedPlayers[socket.id].roster = { mid: 0, sup: 0, jungle: 0, ad: 0, top: 0, acquired: [] };
            connectedPlayers[socket.id].ready = false;

            io.emit('lobby_update', { players: Object.values(connectedPlayers).map(p => ({ nickname: p.nickname, ready: p.ready })) });
            sendPlayerStatusUpdate();
            socket.emit('player_info', { id: socket.id, nickname: connectedPlayers[socket.id].nickname, points: points });
        }
    });

    socket.on('ready', () => {
        if (connectedPlayers[socket.id] && !connectedPlayers[socket.id].ready && gameState.phase === 'Lobby') {
            connectedPlayers[socket.id].ready = true;

            const readyCount = Object.values(connectedPlayers).filter(p => p.ready).length;
            io.emit('lobby_update', { players: Object.values(connectedPlayers).map(p => ({ nickname: p.nickname, ready: p.ready })) });

            if (readyCount === MAX_PLAYERS) {
                // 1차 경매 순서를 위해 0으로 초기화
                gameState.currentItemIndex = 0; 
                gameState.failedAuctionIndex = 0; // 유찰 인덱스 초기화
                gameState.failedAuctionRound = 0; // 유찰 라운드 초기화
                gameState.phase = 'Bidding_Main';
                io.emit('game_start', '3명 모두 준비 완료! 1차 경매를 시작합니다.');
                startPreAuctionWait(); // 첫 아이템 시작 전 대기 타이머부터 시작
            }
        }
    });

    // [경매: 입찰] 이벤트
    socket.on('bid', (newPrice) => {
        if (gameState.phase !== 'Bidding_Main' && gameState.phase !== 'Bidding_Failed') return;
        if (!connectedPlayers[socket.id] || !gameState.currentItem) return;

        // 현재 입찰하려는 포지션은 소문자여야 합니다. (CSV 로드 시 소문자로 통일됨)
        const itemPosition = gameState.currentItem.position; 
        const player = connectedPlayers[socket.id];

        // 1. 🛑 포지션별 1명 제한 체크 (MAX_POS_PER_PLAYER = 1 적용)
        if (player.roster[itemPosition] >= MAX_POS_PER_PLAYER) {
            return socket.emit('error_message', `${itemPosition.toUpperCase()} 포지션 선수는 이미 ${MAX_POS_PER_PLAYER}명을 보유하고 있어 더 이상 입찰할 수 없습니다.`);
        }

        // 2. 연속 입찰 금지
        if (socket.id === gameState.topBidderId) {
            return socket.emit('error_message', '연속 입찰은 불가능합니다. 다음 플레이어만 입찰할 수 있습니다.');
        }

        // 3. 10 포인트 단위 체크
        if (newPrice % BID_INCREMENT !== 0) {
            return socket.emit('error_message', `입찰은 ${BID_INCREMENT} 포인트 단위로만 가능합니다.`);
        }

        const currentPrice = gameState.topBid;

        // 4. 최소 입찰 금액 계산
        let requiredPrice;
        if (currentPrice === 0) {
            requiredPrice = MIN_START_BID;
        } else {
            requiredPrice = currentPrice + BID_INCREMENT;
        }

        if (newPrice < requiredPrice) {
            return socket.emit('error_message', `최소 입찰 금액은 ${requiredPrice} 포인트입니다.`);
        }

        // 5. 포인트 잔액 확인
        if (newPrice > player.points) {
            return socket.emit('error_message', `보유 포인트(${player.points}p)보다 높은 금액(${newPrice}p)으로는 입찰할 수 없습니다.`);
        }

        // 입찰 성공 처리
        gameState.topBid = newPrice;
        gameState.topBidderId = socket.id;

        // 안티 스나이핑: 모든 입찰 시 타이머 리셋
        gameState.timer = ANTI_SNIPING_RESET;
        io.emit('update_timer', { itemId: gameState.currentItem.id, time: gameState.timer });
        console.log(`[Bid] ${player.nickname} ${newPrice}p 입찰. 타이머 ${ANTI_SNIPING_RESET}초로 리셋.`);

        // 입찰가 자동 변경 방지
        io.emit('update_bid', {
            itemId: gameState.currentItem.id,
            price: newPrice, // 현재 최고 입찰가만 전송
            bidder: connectedPlayers[socket.id].nickname
        });

        // 입찰 시 플레이어 상태 업데이트 (최고 입찰자 및 입찰 가능 여부 갱신)
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