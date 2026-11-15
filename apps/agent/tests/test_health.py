from meet_impar_agent.health import (
    ERR_LLM,
    ERR_STT,
    ERR_TTS,
    classify_pipeline_source,
)


def test_classify_pipeline_source() -> None:
    assert classify_pipeline_source("DeepgramSTT", "APIError") == ERR_STT
    assert classify_pipeline_source("LLMStream", "TimeoutError") == ERR_LLM
    assert classify_pipeline_source("ElevenLabsTTS", "HTTPError") == ERR_TTS
    assert classify_pipeline_source("SomethingElse", "Boom") == "other"
