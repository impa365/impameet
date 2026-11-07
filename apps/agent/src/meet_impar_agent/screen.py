"""Optional screen sharing: the agent shows a page or its own topics, and sees what it shows."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol
from urllib.parse import quote

import httpx
from livekit.agents import llm

from .config import ScreenSettings

TIMEOUT_S = 30.0
MAX_TOOL_TEXT = 1500
SCREEN_INSTRUCTIONS = (
    "Você pode mostrar coisas na tela da reunião para todos: use mostrar_pagina para abrir "
    "um site e mostrar_topicos para apresentar um resumo, passos ou uma explicação em tópicos "
    "curtos escritos por você. Depois de mostrar, você recebe uma imagem da tela e o texto "
    "visível: use isso para explicar o que aparece, como uma pessoa apresentando. "
    "Use ver_tela para olhar de novo, rolar_tela para descer ou subir a página e "
    "clicar_na_tela para clicar num texto visível. Todos veem o seu cursor: ao explicar algo "
    "da tela, use apontar_na_tela para mostrar com o mouse o que você está dizendo. "
    "A imagem que você recebe tem números em rosa sobre links, botões, campos, imagens, "
    "ícones e gráficos (só você vê esses números). Para algo sem texto, como um ícone, uma "
    "foto ou um gráfico, use apontar_marca ou clicar_marca com o número. Para um ponto "
    "qualquer da imagem, como uma parte de um gráfico, use apontar_posicao ou clicar_posicao "
    "com x e y de 0 a 100 (porcentagem da largura e da altura da imagem, a partir do canto "
    "superior esquerdo). Os números valem só para a última imagem: depois que a tela muda, "
    "use os da imagem nova. "
    "Use parar_de_mostrar quando terminar. "
    "Sempre diga em voz o que está mostrando."
)
MAX_MARKS_IN_TEXT = 60


CLICK_DID_NOTHING = (
    "Cliquei, mas a tela não mudou: provavelmente esse texto não é um link nem um botão. "
    "Olhe a imagem e tente o texto exato do botão, role a página, ou use mostrar_pagina "
    "com o endereço."
)


@dataclass(frozen=True)
class Mark:
    n: int
    kind: str
    label: str

    def describe(self) -> str:
        return f'{self.n} {self.kind} "{self.label}"' if self.label else f"{self.n} {self.kind}"


@dataclass(frozen=True)
class Snapshot:
    image_b64: str
    title: str
    url: str
    text: str
    changed: bool = True
    marks: tuple[Mark, ...] = ()

    def describe(self) -> str:
        where = f"Título: {self.title}. " if self.title else ""
        where += f"Endereço: {self.url}. " if self.url else ""
        text = self.text[:MAX_TOOL_TEXT]
        out = f"{where}Texto visível na tela: {text or '(nenhum texto)'}"
        if self.marks:
            listed = "; ".join(m.describe() for m in self.marks[:MAX_MARKS_IN_TEXT])
            out += f" Marcas numeradas na imagem: {listed}."
        return out


class Viewer(Protocol):
    async def see(self, snapshot: Snapshot) -> None: ...


class ScreenClient:
    def __init__(
        self,
        settings: ScreenSettings,
        room: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._url = f"{str(settings.url).rstrip('/')}/v1/rooms/{quote(room, safe='')}/screen"
        self._client = httpx.AsyncClient(
            timeout=TIMEOUT_S,
            headers={"x-internal-token": settings.token.get_secret_value()},
            transport=transport,
        )
        self.sharing = False

    async def _request(
        self, method: str, path: str = "", body: dict[str, object] | None = None
    ) -> tuple[dict[str, Any] | None, str]:
        """(json, "") on success, (None, sentence for the model) on failure. Never raises."""
        try:
            res = await self._client.request(method, self._url + path, json=body)
        except httpx.HTTPError:
            return None, "O serviço de tela não respondeu. Diga que não foi possível agora."
        try:
            data = res.json()
        except ValueError:
            data = {}
        if res.is_success and isinstance(data, dict):
            return data, ""
        reason = str(data.get("message", "")) if isinstance(data, dict) else ""
        return None, f"Não foi possível ({reason or res.status_code})."

    async def _show(self, body: dict[str, object]) -> str:
        _, error = await self._request("POST", body=body)
        if error:
            return error
        self.sharing = True
        return ""

    async def show_page(self, url: str) -> str:
        return await self._show({"url": url})

    async def show_topics(self, title: str, topics: list[str]) -> str:
        return await self._show({"title": title, "points": topics})

    async def snapshot(self) -> Snapshot | str:
        data, error = await self._request("GET", "/snapshot")
        return error if data is None else _snapshot(data)

    async def act(self, body: dict[str, object]) -> Snapshot | str:
        data, error = await self._request("POST", "/action", body)
        return error if data is None else _snapshot(data)

    async def stop(self) -> str:
        _, error = await self._request("DELETE")
        if error:
            return error
        self.sharing = False
        return "Parei de mostrar a tela."

    async def aclose(self) -> None:
        if self.sharing:
            await self.stop()
        await self._client.aclose()


def _snapshot(data: dict[str, Any]) -> Snapshot:
    return Snapshot(
        image_b64=str(data.get("image", "")),
        title=str(data.get("title", "")),
        url=str(data.get("url", "")),
        text=str(data.get("text", "")),
        changed=data.get("changed") is not False,
        marks=_marks(data.get("marks")),
    )


def _marks(raw: object) -> tuple[Mark, ...]:
    if not isinstance(raw, list):
        return ()
    marks = []
    for item in raw[:MAX_MARKS_IN_TEXT]:
        if isinstance(item, dict) and isinstance(item.get("n"), int):
            label = str(item.get("label", ""))[:60]
            marks.append(
                Mark(n=item["n"], kind=str(item.get("kind", "elemento"))[:20], label=label)
            )
    return tuple(marks)


async def _look(result: Snapshot | str, viewer: Viewer, done: str) -> str:
    if isinstance(result, str):
        return result
    await viewer.see(result)
    return f"{done} Você está vendo a imagem da tela. {result.describe()}"


def screen_tools(client: ScreenClient, viewer: Viewer) -> list[llm.FunctionTool[..., Any]]:
    @llm.function_tool(name="mostrar_pagina")
    async def show_page(url: str) -> str:
        """Mostra uma página da web na tela da reunião, para todos os participantes.

        Args:
            url: Endereço completo começando com https://
        """
        if error := await client.show_page(url):
            return error
        return await _look(await client.snapshot(), viewer, "A página está na tela para todos.")

    @llm.function_tool(name="mostrar_topicos")
    async def show_topics(titulo: str, topicos: list[str]) -> str:
        """Mostra na tela da reunião um quadro com um título e tópicos curtos.

        Args:
            titulo: Título do quadro.
            topicos: De um a oito tópicos curtos.
        """
        if error := await client.show_topics(titulo, topicos):
            return error
        return await _look(await client.snapshot(), viewer, "Os tópicos estão na tela.")

    @llm.function_tool(name="ver_tela")
    async def look() -> str:
        """Olha de novo a tela que você está mostrando (imagem e texto visível)."""
        return await _look(await client.snapshot(), viewer, "Esta é a tela agora.")

    @llm.function_tool(name="rolar_tela")
    async def scroll(direcao: Literal["baixo", "cima"]) -> str:
        """Rola a página que você está mostrando.

        Args:
            direcao: "baixo" para descer, "cima" para subir.
        """
        body: dict[str, object] = {
            "action": "scroll",
            "direction": "down" if direcao == "baixo" else "up",
        }
        return await _look(await client.act(body), viewer, "Rolei a página.")

    @llm.function_tool(name="clicar_na_tela")
    async def click(texto: str) -> str:
        """Clica num link ou botão visível na tela, pelo texto que aparece nele.

        Args:
            texto: O texto do link ou botão, como aparece na tela.
        """
        body: dict[str, object] = {"action": "click", "text": texto}
        result = await client.act(body)
        if isinstance(result, Snapshot) and not result.changed:
            return await _look(result, viewer, CLICK_DID_NOTHING)
        return await _look(result, viewer, "Cliquei.")

    @llm.function_tool(name="apontar_na_tela")
    async def point(texto: str) -> str:
        """Leva o seu cursor até algo visível na tela e destaca, sem clicar. Use enquanto
        explica, como uma pessoa que mostra com o mouse: "olha aqui, esse é o plano Pro".

        Args:
            texto: O texto que aparece na tela, no ponto que você quer mostrar.
        """
        body: dict[str, object] = {"action": "point", "text": texto}
        return await _look(await client.act(body), viewer, "Seu cursor está apontando para isso.")

    async def act(body: dict[str, object], done: str) -> str:
        result = await client.act(body)
        if isinstance(result, Snapshot) and not result.changed:
            return await _look(result, viewer, CLICK_DID_NOTHING)
        return await _look(result, viewer, done)

    @llm.function_tool(name="apontar_marca")
    async def point_mark(numero: int) -> str:
        """Leva o seu cursor até o elemento com esse número na última imagem da tela e o
        destaca, sem clicar. Serve para coisas sem texto: ícones, fotos, gráficos.

        Args:
            numero: O número em rosa que aparece sobre o elemento na imagem.
        """
        return await act({"action": "point_mark", "mark": numero}, "Seu cursor está ali.")

    @llm.function_tool(name="clicar_marca")
    async def click_mark(numero: int) -> str:
        """Clica no elemento com esse número na última imagem da tela.

        Args:
            numero: O número em rosa que aparece sobre o elemento na imagem.
        """
        return await act({"action": "click_mark", "mark": numero}, "Cliquei.")

    @llm.function_tool(name="apontar_posicao")
    async def point_at(x: float, y: float) -> str:
        """Leva o seu cursor até um ponto da imagem da tela e marca com um círculo, sem clicar.
        Use para partes de gráficos, fotos ou qualquer região sem número.

        Args:
            x: Posição horizontal, de 0 (esquerda) a 100 (direita) da imagem.
            y: Posição vertical, de 0 (topo) a 100 (base) da imagem.
        """
        return await act({"action": "point_at", "x": x, "y": y}, "Seu cursor está nesse ponto.")

    @llm.function_tool(name="clicar_posicao")
    async def click_at(x: float, y: float) -> str:
        """Clica num ponto da imagem da tela.

        Args:
            x: Posição horizontal, de 0 (esquerda) a 100 (direita) da imagem.
            y: Posição vertical, de 0 (topo) a 100 (base) da imagem.
        """
        return await act({"action": "click_at", "x": x, "y": y}, "Cliquei nesse ponto.")

    @llm.function_tool(name="parar_de_mostrar")
    async def stop() -> str:
        """Para de mostrar a tela na reunião."""
        return await client.stop()

    return [
        show_page,
        show_topics,
        look,
        scroll,
        click,
        point,
        point_mark,
        click_mark,
        point_at,
        click_at,
        stop,
    ]
